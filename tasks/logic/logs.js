const GIFEncoder = require('gifencoder');
const sharp = require('sharp');
const axios = require('axios');
const { Canvas, Image } = require('canvas');
const { agentQueue } = require('../services/queue');
const { uploadFileToS3 } = require('../services/s3');
const db = require('../services/db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_TO_FILE =
    String(process.env.LOG_TO_FILE || '').toLowerCase() === '1' ||
    String(process.env.LOG_TO_FILE || '').toLowerCase() === 'true';
const LOG_FILE_PATH =
    process.env.LOG_FILE_PATH ||
    path.join(process.cwd(), 'logs', 'node-logs.jsonl');

async function appendGifLog({ flowId, runId, message, data }) {
    if (!LOG_TO_FILE) return;
    try {
        const dir = path.dirname(LOG_FILE_PATH);
        fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            segment: 'gif',
            flowId,
            runId,
            message,
            data: data || null,
        });
        await fs.promises.appendFile(LOG_FILE_PATH, line + '\n');
    } catch (e) {
        console.error('Failed to append gif log to file:', e);
    }
}

function normalizeImageUrl(url) {
    if (!url) return null;
    const publicDomain = process.env.S3_PUBLIC_DOMAIN;
    const privateDomain = process.env.S3_PRIVATE_DOMAIN;
    if (publicDomain && privateDomain && url.startsWith(publicDomain)) {
        return url.replace(publicDomain, privateDomain);
    }
    if (privateDomain && url.startsWith("http://localhost:9100")) {
        return url.replace("http://localhost:9100", privateDomain);
    }
    return url;
}

// Helper function to extract image URLs from messages
function extractImageUrlsFromMessages(messages) {
    const imageUrls = [];
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const content of message.content) {
            if (content.type === 'image_url' || content.type === 'image') {
                imageUrls.push(
                    normalizeImageUrl(content.url || content.image_url?.url)
                );
            }
            if (Array.isArray(content.associatedData)) {
                for (const assoc of content.associatedData) {
                    if (
                        assoc.type === 'image_url' ||
                        assoc.type === 'image'
                    ) {
                        imageUrls.push(
                            normalizeImageUrl(
                                assoc.url || assoc.image_url?.url
                            )
                        );
                    }
                }
            }
        }
    }
    return imageUrls.filter(Boolean);
}

// Helper function to download image and convert to Buffer
async function downloadImage(url, index, total) {
    if (typeof index === "number" && typeof total === "number") {
        console.log(`[gif] downloading image ${index + 1}/${total}: ${url}`);
        await appendGifLog({
            flowId: null,
            runId: null,
            message: `downloading image ${index + 1}/${total}`,
            data: { url },
        });
    }
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
}

// Create GIF from array of image buffers
async function createGif(imageBuffers) {
    const width = Number(process.env.BROWSER_WIDTH) || 800;
    const height = Number(process.env.BROWSER_HEIGHT) || 600;
    // scale down 0.8
    const scaledWidth = width * 0.8;
    const scaledHeight = height * 0.8;
    const encoder = new GIFEncoder(scaledWidth, scaledHeight); // Set dimensions as needed
    const canvas = new Canvas(scaledWidth, scaledHeight);
    const ctx = canvas.getContext('2d');
    
    encoder.start();
    encoder.setRepeat(0);   // 0 for repeat, -1 for no-repeat
    encoder.setDelay(1000); // Frame delay in ms
    encoder.setQuality(10); // Image quality (1-30)
    
    const totalFrames = imageBuffers.length;
    const startTime = Date.now();
    for (let i = 0; i < imageBuffers.length; i++) {
        const buffer = imageBuffers[i];
        const frameStart = Date.now();
        // Create a new Image instance
        const image = await sharp(buffer)
            .resize(scaledWidth, scaledHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .toFormat('png')  // Convert to PNG for better compatibility
            .toBuffer();
            
        // Load the image onto the canvas
        const img = await loadImage(image);
        ctx.drawImage(img, 0, 0);
        encoder.addFrame(ctx);

        const elapsed = (Date.now() - startTime) / 1000;
        const avg = elapsed / (i + 1);
        const remaining = avg * (totalFrames - (i + 1));
        console.log(
            `[gif] encoding frame ${i + 1}/${totalFrames} (${((Date.now() - frameStart) / 1000).toFixed(2)}s). ETA ${remaining.toFixed(1)}s`
        );
        await appendGifLog({
            flowId: null,
            runId: null,
            message: `encoding frame ${i + 1}/${totalFrames}`,
            data: {
                frameSeconds: (Date.now() - frameStart) / 1000,
                etaSeconds: Number(remaining.toFixed(1)),
            },
        });
    }
    
    encoder.finish();
    return encoder.out.getData();
}

// Helper function to load image
function loadImage(buffer) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = buffer;
    });
}

async function createGifFromMessageLogs({ flowId, runId, accountId }) {
    try {
        console.log(`[gif] start flowId=${flowId} runId=${runId || "latest"} accountId=${accountId || "n/a"}`);
        await appendGifLog({
            flowId,
            runId: runId || null,
            message: 'gif start',
            data: { accountId: accountId || null },
        });
        const tasksDB = await db.getTasksDB();
        
        // If runId not provided, get the latest run for the flow
        let targetRunId = runId;
        if (!targetRunId) {
            const { rows: runs } = await tasksDB.query(
                `SELECT id FROM browserable.runs WHERE flow_id = $1 AND account_id = $2 ORDER BY created_at DESC LIMIT 1`,
                [flowId, accountId]
            );
            if (runs.length === 0) {
                throw new Error('No runs found for this flow');
            }
            targetRunId = runs[0].id;
        }
        console.log(`[gif] targetRunId=${targetRunId}`);
        await appendGifLog({
            flowId,
            runId: targetRunId,
            message: 'target run selected',
        });

        // Get all messages for the run (agent + user + debug)
        const { rows: messageLogs } = await tasksDB.query(
            `SELECT messages FROM browserable.message_logs 
             WHERE flow_id = $1 AND run_id = $2 AND segment IN ('agent', 'user', 'debug') 
             ORDER BY created_at ASC`,
            [flowId, targetRunId]
        );
        console.log(`[gif] message logs fetched: ${messageLogs.length}`);
        await appendGifLog({
            flowId,
            runId: targetRunId,
            message: 'message logs fetched',
            data: { count: messageLogs.length },
        });
        
        // Extract image URLs from messages
        const allImageUrls = messageLogs.flatMap((log) => {
            const raw = log.messages;
            let parsed = raw;
            if (typeof raw === 'string') {
                try {
                    parsed = JSON.parse(raw);
                } catch (e) {
                    parsed = [];
                }
            }
            return extractImageUrlsFromMessages(parsed || []);
        });
        const dedupedImageUrls = Array.from(new Set(allImageUrls));
        console.log(`[gif] image urls: total=${allImageUrls.length} deduped=${dedupedImageUrls.length}`);
        await appendGifLog({
            flowId,
            runId: targetRunId,
            message: 'image urls extracted',
            data: {
                total: allImageUrls.length,
                deduped: dedupedImageUrls.length,
            },
        });

        if (dedupedImageUrls.length === 0) {
            throw new Error('No images found in the messages');
        }
        
        // Download all images
        console.log(`[gif] downloading ${dedupedImageUrls.length} images...`);
        await appendGifLog({
            flowId,
            runId: targetRunId,
            message: 'downloading images',
            data: { count: dedupedImageUrls.length },
        });
        const imageBuffers = await Promise.all(
            dedupedImageUrls.map((url, idx) =>
                downloadImage(url, idx, dedupedImageUrls.length)
            )
        );
        console.log(`[gif] downloaded ${imageBuffers.length} images`);
        await appendGifLog({
            flowId,
            runId: targetRunId,
            message: 'download complete',
            data: { count: imageBuffers.length },
        });

        // Deduplicate identical images by content hash
        const seen = new Set();
        const uniqueBuffers = [];
        for (const buffer of imageBuffers) {
            const hash = crypto
                .createHash('sha1')
                .update(buffer)
                .digest('hex');
            if (!seen.has(hash)) {
                seen.add(hash);
                uniqueBuffers.push(buffer);
            }
        }
        if (uniqueBuffers.length !== imageBuffers.length) {
            console.log(
                `[gif] deduped images: ${imageBuffers.length} -> ${uniqueBuffers.length}`
            );
            await appendGifLog({
                flowId,
                runId: targetRunId,
                message: 'image buffers deduped',
                data: {
                    before: imageBuffers.length,
                    after: uniqueBuffers.length,
                },
            });
        }
        
        // Create GIF
        console.log(`[gif] encoding gif...`);
        await appendGifLog({
            flowId,
            runId: targetRunId,
            message: 'encoding gif',
        });
        const gifBuffer = await createGif(uniqueBuffers);
        console.log(`[gif] gif encoded: ${gifBuffer?.length || 0} bytes`);
        await appendGifLog({
            flowId,
            runId: targetRunId,
            message: 'gif encoded',
            data: { bytes: gifBuffer?.length || 0 },
        });

        // Upload to S3
        const result = await uploadFileToS3({
            name: `${Date.now()}.gif`,
            file: gifBuffer,
            folder: `runs/${targetRunId}/gifs`,
            contentType: 'image/gif'
        });
        
        if (!result) {
            throw new Error('Failed to upload GIF');
        }
        console.log(`[gif] uploaded gif: ${result.publicUrl}`);
        await appendGifLog({
            flowId,
            runId: targetRunId,
            message: 'gif uploaded',
            data: { url: result.publicUrl },
        });
        
        return {
            success: true,
            gifUrl: result.publicUrl,
            privateGifUrl: result.privateUrl,
            runId: targetRunId
        };
        
    } catch (error) {
        console.error('Error creating GIF:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

async function getGifStatus({ flowId, runId, accountId }) {
    try {
        const tasksDB = await db.getTasksDB();
        
        // If runId not provided, get the latest run for the flow
        let targetRunId = runId;
        if (!targetRunId) {
            const { rows: runs } = await tasksDB.query(
                `SELECT id FROM browserable.runs WHERE flow_id = $1 AND account_id = $2 ORDER BY created_at DESC LIMIT 1`,
                [flowId, accountId]
            );
            if (runs.length === 0) {
                throw new Error('No runs found for this flow');
            }
            targetRunId = runs[0].id;
        }

        // Get run status
        const { rows: runs } = await tasksDB.query(
            `SELECT status, error, private_data FROM browserable.runs 
            WHERE id = $1 AND flow_id = $2 AND account_id = $3`,
            [targetRunId, flowId, accountId]
        );

        if (runs.length === 0) {
            throw new Error('Run not found');
        }

        const run = runs[0];

        // Check if run is still in progress
        if (run.status !== 'completed' && run.status !== 'error' && !run.error) {
            return {
                success: true,
                data: {
                    status: 'pending'
                }
            };
        }

        // Check if run errored
        if (run.status === 'error' || run.error) {
            return {
                success: true,
                data: {
                    status: 'error',
                    error: run.error
                }
            };
        }

        // Run is completed, check for gifUrl
        if (run.private_data?.gifUrl) {
            return {
                success: true,
                data: {
                    status: 'completed',
                    url: run.private_data.gifUrl
                }
            };
        }

        // No gifUrl found, queue creation job
        await agentQueue.add('create-gif', {
            flowId,
            runId: targetRunId,
            accountId
        });

        return {
            success: true,
            data: {
                status: 'pending'
            }
        };

    } catch (error) {
        console.error('Error getting GIF status:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = {
    createGifFromMessageLogs,
    getGifStatus
};
