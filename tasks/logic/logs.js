const GIFEncoder = require('gifencoder');
const sharp = require('sharp');
const axios = require('axios');
const { Canvas, Image } = require('canvas');
const { agentQueue } = require('../services/queue');
const { uploadFileToS3 } = require('../services/s3');
const db = require('../services/db');

// Helper function to extract image URLs from messages
function extractImageUrlsFromMessages(messages) {
    const imageUrls = [];
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const content of message.content) {
            if (content.type === 'image_url' || content.type === 'image') {
                imageUrls.push(content.url || content.image_url?.url);
            }
            if (Array.isArray(content.associatedData)) {
                for (const assoc of content.associatedData) {
                    if (
                        assoc.type === 'image_url' ||
                        assoc.type === 'image'
                    ) {
                        imageUrls.push(
                            assoc.url || assoc.image_url?.url
                        );
                    }
                }
            }
        }
    }
    return imageUrls;
}

// Helper function to download image and convert to Buffer
async function downloadImage(url) {
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
    
    for (const buffer of imageBuffers) {
        // Create a new Image instance
        const image = await sharp(buffer)
            .resize(scaledWidth, scaledHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .toFormat('png')  // Convert to PNG for better compatibility
            .toBuffer();
            
        // Load the image onto the canvas
        const img = await loadImage(image);
        ctx.drawImage(img, 0, 0);
        encoder.addFrame(ctx);
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

        // Get all messages for the run (agent + user + debug)
        const { rows: messageLogs } = await tasksDB.query(
            `SELECT messages FROM browserable.message_logs 
             WHERE flow_id = $1 AND run_id = $2 AND segment IN ('agent', 'user', 'debug') 
             ORDER BY created_at ASC`,
            [flowId, targetRunId]
        );
        
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

        if (allImageUrls.length === 0) {
            throw new Error('No images found in the messages');
        }
        
        // Download all images
        const imageBuffers = await Promise.all(
            allImageUrls.map(url => downloadImage(url))
        );
        
        // Create GIF
        const gifBuffer = await createGif(imageBuffers);

        // Upload to S3
        const result = await uploadFileToS3({
            name: `${Date.now()}.gif`,
            file: gifBuffer,
            folder: `runs/${runId}/gifs`,
            contentType: 'image/gif'
        });
        
        if (!result) {
            throw new Error('Failed to upload GIF');
        }
        
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
