const { baseAgent, BaseAgent } = require("./base");
const { z } = require("zod");
const sharp = require("sharp");
const {
    needNewSession,
    scrapeUrl,
    doneWithSession,
} = require("../logic/integrations/browser");
const { chromium } = require("playwright");
const browserService = require("../services/browser");
const { uploadFileToS3 } = require("../services/s3");
const { NodeHtmlMarkdown } = require("node-html-markdown");
var axios = require("axios");
const axiosInstance = axios.create({
    withCredentials: true,
});
const {
    callOpenAICompatibleLLMWithRetry,
    updateMetadataOfLLMCall,
} = require("../services/llm");
const {
    agents: { browserable: browserablePrompts },
} = require("../prompts");
const textSchema = z.object({
    text: z.string().min(1, "Text cannot be empty"),
});

const HEURISTIC_CHAR_WIDTH = 5;

async function ensureWebviewJSInjected(page) {
    // Inject into main frame
    const isInjected = await page.evaluate(() => {
        return window.webviewJSInjected === true;
    });

    if (!isInjected) {
        const evaluateScript = `(() => {
            if (!window.webviewJSInjected) {
                ${webviewJS}
                window.webviewJSInjected = true;
            }
            return window.webviewJSInjected;
        })()`;

        await page.evaluate(evaluateScript);
    }
}

async function scrollOnPage({ page, runId, nodeId, x, y, deltaX, deltaY }) {
    // move the cursor to x, y
    await page.mouse.move(x, y);

    // scroll the page
    await page.mouse.wheel(deltaX, deltaY);
}

async function typeOnPage({ page, text, runId, nodeId, x, y }) {
    // click on the page at x, y
    await page.mouse.click(x, y);

    // type into the page
    await page.keyboard.type(text);
}

async function clickOnPage({ page, runId, nodeId, x, y, doubleClick = false }) {
    if (doubleClick) {
        await page.mouse.dblclick(x, y);
    } else {
        await page.mouse.click(x, y);
    }
}

async function keyOnPage({ page, runId, nodeId, key }) {
    // key into the page
    await page.keyboard.press(key);
}

function formatText(textAnnotations, pageWidth) {
    const sortedAnnotations = [...textAnnotations].sort(
        (a, b) => a.bottom_left.y - b.bottom_left.y
    );

    const epsilon = 1;
    const lineMap = new Map();

    for (const annotation of sortedAnnotations) {
        let foundLineY;
        for (const key of lineMap.keys()) {
            if (Math.abs(key - annotation.bottom_left.y) < epsilon) {
                foundLineY = key;
                break;
            }
        }

        if (foundLineY !== undefined) {
            lineMap.get(foundLineY).push(annotation);
        } else {
            lineMap.set(annotation.bottom_left.y, [annotation]);
        }
    }

    const lineYs = Array.from(lineMap.keys()).sort((a, b) => a - b);
    const finalLines = [];

    for (const lineY of lineYs) {
        const lineAnnotations = lineMap.get(lineY);
        lineAnnotations.sort((a, b) => a.bottom_left.x - b.bottom_left.x);
        finalLines.push(groupWordsInSentence(lineAnnotations));
    }

    let maxLineWidthInChars = 0;

    for (const line of finalLines) {
        let lineMaxEnd = 0;
        for (const ann of line) {
            const startXInChars = Math.round(
                ann.bottom_left_normalized.x *
                    (pageWidth / HEURISTIC_CHAR_WIDTH)
            );
            const endXInChars = startXInChars + ann.text.length;
            lineMaxEnd = Math.max(lineMaxEnd, endXInChars);
        }
        maxLineWidthInChars = Math.max(maxLineWidthInChars, lineMaxEnd);
    }

    maxLineWidthInChars += 20;
    const canvasWidth = Math.max(maxLineWidthInChars, 1);
    const lineBaselines = finalLines.map((line) =>
        Math.min(...line.map((a) => a.bottom_left.y))
    );

    const verticalGaps = [];
    for (let i = 1; i < lineBaselines.length; i++) {
        verticalGaps.push(lineBaselines[i] - lineBaselines[i - 1]);
    }

    const normalLineSpacing =
        verticalGaps.length > 0 ? median(verticalGaps) : 0;
    let canvas = [];
    let lineIndex = -1;

    for (let i = 0; i < finalLines.length; i++) {
        if (i === 0) {
            lineIndex++;
            ensureLineExists(canvas, lineIndex, canvasWidth);
        } else {
            const gap = lineBaselines[i] - lineBaselines[i - 1];
            let extraLines = 0;
            if (normalLineSpacing > 0 && gap > 1.2 * normalLineSpacing) {
                extraLines = Math.max(
                    Math.round(gap / normalLineSpacing) - 1,
                    0
                );
            }
            for (let e = 0; e < extraLines; e++) {
                lineIndex++;
                ensureLineExists(canvas, lineIndex, canvasWidth);
            }
            lineIndex++;
            ensureLineExists(canvas, lineIndex, canvasWidth);
        }

        const lineAnnotations = finalLines[i];
        for (const annotation of lineAnnotations) {
            const text = annotation.text;
            const startXInChars = Math.round(
                annotation.bottom_left_normalized.x *
                    (pageWidth / HEURISTIC_CHAR_WIDTH)
            );
            for (let j = 0; j < text.length; j++) {
                const xPos = startXInChars + j;
                if (xPos < canvasWidth) {
                    canvas[lineIndex][xPos] = text[j];
                }
            }
        }
    }

    canvas = canvas.map((row) => {
        const lineStr = row.join("");
        return Array.from(lineStr.trimEnd());
    });

    let pageText = canvas
        .map((line) => line.join(""))
        .join("\n")
        .trimEnd();

    pageText =
        "-".repeat(canvasWidth) +
        "\n" +
        pageText +
        "\n" +
        "-".repeat(canvasWidth);
    return pageText;
}

function ensureLineExists(canvas, lineIndex, width) {
    while (lineIndex >= canvas.length) {
        canvas.push(new Array(width).fill(" "));
    }
}

function groupWordsInSentence(lineAnnotations) {
    const groupedAnnotations = [];
    let currentGroup = [];

    for (const annotation of lineAnnotations) {
        if (currentGroup.length === 0) {
            currentGroup.push(annotation);
            continue;
        }

        const padding = 1;
        const lastAnn = currentGroup[currentGroup.length - 1];
        const characterWidth = (lastAnn.width / lastAnn.text.length) * padding;
        const isWithinHorizontalRange =
            annotation.bottom_left.x <=
            lastAnn.bottom_left.x + lastAnn.width + characterWidth;

        if (
            Math.abs(annotation.height - currentGroup[0].height) <= 4 &&
            isWithinHorizontalRange
        ) {
            currentGroup.push(annotation);
        } else {
            if (currentGroup.length > 0) {
                const groupedAnnotation = createGroupedAnnotation(currentGroup);
                if (groupedAnnotation.text.length > 0) {
                    groupedAnnotations.push(groupedAnnotation);
                }
                currentGroup = [annotation];
            }
        }
    }

    if (currentGroup.length > 0) {
        const groupedAnnotation = createGroupedAnnotation(currentGroup);
        groupedAnnotations.push(groupedAnnotation);
    }

    return groupedAnnotations;
}

function createGroupedAnnotation(group) {
    let text = "";

    for (const word of group) {
        if (
            [
                ".",
                ",",
                '"',
                "'",
                ":",
                ";",
                "!",
                "?",
                "{",
                "}",
                "’",
                "”",
            ].includes(word.text)
        ) {
            text += word.text;
        } else {
            text += text !== "" ? " " + word.text : word.text;
        }
    }

    const isWord = /[a-zA-Z0-9]/.test(text);
    const medianHeight = median(group.map((word) => word.height));

    if (isWord && medianHeight > 25) {
        text = "**" + text + "**";
    }

    return {
        text: text,
        bottom_left: {
            x: group[0].bottom_left.x,
            y: group[0].bottom_left.y,
        },
        bottom_left_normalized: {
            x: group[0].bottom_left_normalized.x,
            y: group[0].bottom_left_normalized.y,
        },
        width: group.reduce((sum, a) => sum + a.width, 0),
        height: group[0].height,
    };
}

function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

const webviewJS = `
//----------------------------------------------------------------------------------------//

function generateUniqueId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}
if (!window.generatedUniqueId) {
  window.generatedUniqueId = generateUniqueId();
}

function waitForDomSettle() {
  return new Promise(function (resolve) {
    function createTimeout() {
      return setTimeout(function () {
        resolve();
      }, 2000);
    }
    
    let timeout = createTimeout();
    const observer = new MutationObserver(function () {
      clearTimeout(timeout);
      timeout = createTimeout();
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
window.waitForDomSettle = waitForDomSettle;



function calculateViewportHeight() {
  return Math.ceil(window.innerHeight * 0.75);
}
window.calculateViewportHeight = calculateViewportHeight;

function canElementScroll(elem) {
  if (typeof elem.scrollTo !== "function") {
    console.warn("canElementScroll: .scrollTo is not a function.");
    return false;
  }

  try {
    const originalTop = elem.scrollTop;
    
    elem.scrollTo({
      top: originalTop + 100,
      left: 0,
      behavior: "instant"
    });
    
    if (elem.scrollTop === originalTop) {
      throw new Error("scrollTop did not change");
    }
    
    elem.scrollTo({
      top: originalTop,
      left: 0,
      behavior: "instant"
    });
    
    return true;
  } catch (error) {
    console.warn("canElementScroll error:", error.message || error);
    return false;
  }
}
window.canElementScroll = canElementScroll;


function isElementNode(node) {
  return node.nodeType === Node.ELEMENT_NODE;
}
window.isElementNode = isElementNode;

function isTextNode(node) {
  return node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim());
}
window.isTextNode = isTextNode;

function getParentElement(node) {
  return node.parentElement;
}
window.getParentElement = getParentElement;

function getScrollableElements(topN) {
  const docEl = document.documentElement;
  const scrollableElements = [docEl];
  const allElements = document.querySelectorAll("*");

  for (const elem of allElements) {
    const style = window.getComputedStyle(elem);
    const overflowY = style.overflowY;
    const isPotentiallyScrollable = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
    if (isPotentiallyScrollable) {
      const candidateScrollDiff = elem.scrollHeight - elem.clientHeight;
      if (candidateScrollDiff > 0 && canElementScroll(elem)) {
        scrollableElements.push(elem);
      }
    }
  }
  scrollableElements.sort((a, b) => b.scrollHeight - a.scrollHeight);
  return topN !== undefined ? scrollableElements.slice(0, topN) : scrollableElements;
}
window.getScrollableElements = getScrollableElements;

async function generatedIdBasedXPath(element) {
  if (isElementNode(element) && element.id) {
    return '//*[@id=' + "'" + element.id + "'" + ']';
  }
  return null;
}
window.generatedIdBasedXPath = generatedIdBasedXPath;

async function generateStandardXPath(element) {
  const parts = [];
  while (element && (isTextNode(element) || isElementNode(element))) {
    let index = 0;
    let hasSameTypeSiblings = false;
    const siblings = element.parentElement
      ? Array.from(element.parentElement.childNodes)
      : [];
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (
        sibling.nodeType === element.nodeType &&
        sibling.nodeName === element.nodeName
      ) {
        index = index + 1;
        hasSameTypeSiblings = true;
        if (sibling.isSameNode(element)) {
          break;
        }
      }
    }
    // text "nodes" are selected differently than elements with xPaths
    if (element.nodeName !== "#text") {
      const tagName = element.nodeName.toLowerCase();
      const pathIndex = hasSameTypeSiblings ? '[' + index + ']' : '';
      parts.unshift(tagName + pathIndex);
    }
    element = element.parentElement;
  }
  return parts.length ? '/' + parts.join('/') : '';
}
window.generateStandardXPath = generateStandardXPath;


async function generateComplexXPath(element) {
  const parts = [];
  let currentElement = element;

  while (
    currentElement &&
    (isTextNode(currentElement) || isElementNode(currentElement))
  ) {
    if (isElementNode(currentElement)) {
      const el = currentElement;
      let selector = el.tagName.toLowerCase();

      // List of attributes to consider for uniqueness
      const attributePriority = [
        "data-qa",
        "data-component",
        "data-role",
        "role",
        "aria-role",
        "type",
        "name",
        "aria-label",
        "placeholder",
        "title",
        "alt",
      ];

      // Collect attributes present on the element
      const attributes = attributePriority
        .map(function(attr) {
          let value = el.getAttribute(attr);
          if (attr === "href-full" && value) {
            value = el.getAttribute("href");
          }
          return value
            ? { attr: attr === "href-full" ? "href" : attr, value }
            : null;
        })
        .filter(function(attr) { return attr !== null; });

      // Attempt to find a combination of attributes that uniquely identifies the element
      let uniqueSelector = "";
      for (let i = 1; i <= attributes.length; i++) {
        const combinations = getCombinations(attributes, i);
        for (const combo of combinations) {
          const conditions = combo
            .map(function(a) { return '@' + a.attr + '=' + escapeXPathString(a.value); })
            .join(" and ");
          const xpath = '//' + selector + '[' + conditions + ']';
          if (isXPathFirstResultElement(xpath, el)) {
            uniqueSelector = xpath;
            break;
          }
        }
        if (uniqueSelector) break;
      }

      if (uniqueSelector) {
        parts.unshift(uniqueSelector.replace('//', ''));
        break;
      } else {
        // Fallback to positional selector
        const parent = getParentElement(el);
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            function(sibling) { return sibling.tagName === el.tagName; }
          );
          const index = siblings.indexOf(el) + 1;
          selector += siblings.length > 1 ? '[' + index + ']' : '';
        }
        parts.unshift(selector);
      }
    }

    currentElement = getParentElement(currentElement);
  }

  const xpath = '//' + parts.join('/');
  return xpath;
}
window.generateComplexXPath = generateComplexXPath;



function getCombinations(attributes, size) {
  const results = [];

  function helper(start, combo) {
    if (combo.length === size) {
      results.push([...combo]);
      return;
    }
    for (let i = start; i < attributes.length; i++) {
      combo.push(attributes[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }

  helper(0, []);
  return results;
}
window.getCombinations = getCombinations;


function isXPathFirstResultElement(xpath, target) {
  try {
    const result = document.evaluate(
      xpath,
      document.documentElement,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    return result.snapshotItem(0) === target;
  } catch (error) {
    // If there's an error evaluating the XPath, consider it not unique
    console.warn("Invalid XPath expression: " + xpath, error);
    return false;
  }
}
window.isXPathFirstResultElement = isXPathFirstResultElement;

async function generateXPathsForElement(element) {
  if (!element) return [];
  const [complexXPath, standardXPath, idBasedXPath] = await Promise.all([
    generateComplexXPath(element),
    generateStandardXPath(element),
    generatedIdBasedXPath(element),
  ]);

  // This should return in order from most accurate on current page to most cachable.
  // Do not change the order if you are not sure what you are doing.
  return [standardXPath, ...(idBasedXPath ? [idBasedXPath] : []), complexXPath];
}
window.generateXPathsForElement = generateXPathsForElement;


function escapeXPathString(value) {
  if (value.includes("'")) {
    if (value.includes('"')) {
      // If the value contains both single and double quotes, split into parts
      return (
        "concat(" +
        value
          .split(/('+)/)
          .map(function(part) {
            if (part === "'") {
              return '"' + "'" + '"';
            } else if (part.startsWith("'") && part.endsWith("'")) {
              return '"' + part + '"';
            } else {
              return "'" + part + "'";
            }
          })
          .join(",") +
        ")"
      );
    } else {
      // Contains single quotes but not double quotes; use double quotes
      return '"' + value + '"';
    }
  } else {
    // Does not contain single quotes; use single quotes
    return "'" + value + "'";
  }
}
window.escapeXPathString = escapeXPathString;






function isVisible(element, allowOffscreen = false) {
  const rect = element.getBoundingClientRect();
  if (
    !allowOffscreen &&
    (rect.width === 0 || rect.height === 0 || rect.top < 0 || rect.top > window.innerHeight)
  ) {
    return false;
  }
  if (!isTopElement(element, rect, allowOffscreen)) {
    return false;
  }
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  return true;
}
window.isVisible = isVisible;

function isTextVisible(element, allowOffscreen = false) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const rect = range.getBoundingClientRect();

  if (
    !allowOffscreen &&
    (rect.width === 0 || rect.height === 0 || rect.top < 0 || rect.top > window.innerHeight)
  ) {
    return false;
  }
  const parent = element.parentElement;
  if (!parent) {
    return false;
  }
  if (typeof parent.checkVisibility === "function") {
    return parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  return true;
}
window.isTextVisible = isTextVisible;

function isTopElement(elem, rect) {
  const points = [
    { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.25 },
    { x: rect.left + rect.width * 0.75, y: rect.top + rect.height * 0.25 },
    { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.75 },
    { x: rect.left + rect.width * 0.75, y: rect.top + rect.height * 0.75 },
    { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  ];

  return points.some((point) => {
    const topEl = document.elementFromPoint(point.x, point.y);
    let current = topEl;
    while (current && current !== document.body) {
      if (current.isSameNode(elem)) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  });
}
window.isTopElement = isTopElement;

function isActive(element) {
  return !(
    element.hasAttribute("disabled") ||
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-disabled") === "true"
  );
}
window.isActive = isActive;

function isInteractiveElement(element) {
  const elementType = element.tagName;
  const elementRole = element.getAttribute("role");
  const elementAriaRole = element.getAttribute("aria-role");
  const interactiveElementTypes = [
    "A", "BUTTON", "DETAILS", "EMBED", "INPUT", "LABEL", "MENU",
    "MENUITEM", "OBJECT", "SELECT", "TEXTAREA", "SUMMARY"
  ];
  const interactiveRoles = [
    "button", "menu", "menuitem", "link", "checkbox", "radio", "slider", "tab",
    "tabpanel", "textbox", "combobox", "grid", "listbox", "option", "progressbar",
    "scrollbar", "searchbox", "switch", "tree", "treeitem", "spinbutton", "tooltip"
  ];
  const interactiveAriaRoles = ["menu", "menuitem", "button"];

  return (
    (elementType && interactiveElementTypes.includes(elementType)) ||
    (elementRole && interactiveRoles.includes(elementRole)) ||
    (elementAriaRole && interactiveAriaRoles.includes(elementAriaRole))
  );
}
window.isInteractiveElement = isInteractiveElement;

function isLeafElement(element) {
    const leafElementDenyList = ["SVG", "IFRAME", "SCRIPT", "STYLE", "LINK"];
  if (element.textContent === "") {
    return false;
  }
  if (element.childNodes.length === 0) {
    return !leafElementDenyList.includes(element.tagName);
  }
  if (element.childNodes.length === 1 && element.childNodes[0].nodeType === Node.TEXT_NODE) {
    return true;
  }
  return false;
}
window.isLeafElement = isLeafElement;

function pickChunk(chunksSeen) {
  const viewportHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight;
  const chunks = Math.ceil(documentHeight / viewportHeight);
  const chunksArray = Array.from({ length: chunks }, (_, i) => i);
  const chunksRemaining = chunksArray.filter((chunk) => !chunksSeen.includes(chunk));

  const currentScrollPosition = window.scrollY;
  const closestChunk = chunksRemaining.reduce((closest, current) => {
    const currentChunkTop = viewportHeight * current;
    const closestChunkTop = viewportHeight * closest;
    return Math.abs(currentScrollPosition - currentChunkTop) <
      Math.abs(currentScrollPosition - closestChunkTop)
      ? current
      : closest;
  }, chunksRemaining[0]);

  if (closestChunk === undefined) {
    throw new Error("No chunks remaining to check: " + chunksRemaining);
  }
  return { chunk: closestChunk, chunksArray };
}
window.pickChunk = pickChunk;


function getChunksInfo() {
  const viewportHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight;
  const totalChunks = Math.ceil(documentHeight / viewportHeight);
  const chunksArray = Array.from({ length: totalChunks }, (_, i) => i);

  const currentScrollPosition = window.scrollY;
  const currentChunk = Math.floor(currentScrollPosition / viewportHeight);


  return { 
    currentChunk,
    totalChunks,
  };
}
window.getChunksInfo = getChunksInfo;




async function getScrollableElementXpaths(topN) {
  const scrollableElems = getScrollableElements(topN);
  const xpaths = [];
  for (const elem of scrollableElems) {
    const allXPaths = await generateXPathsForElement(elem);
    xpaths.push(allXPaths?.[0] || "");
  }
  return xpaths;
}
window.getScrollableElementXpaths = getScrollableElementXpaths;

function getViewportHeight(el) {
    return el instanceof Window ? calculateViewportHeight() : el.clientHeight;
}
window.getViewportHeight = getViewportHeight;

function getScrollHeight(el) {
    return el instanceof Window ? document.documentElement.scrollHeight : el.scrollHeight;
}
window.getScrollHeight = getScrollHeight;

async function scrollElementTo(el, offset) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // console.log("Scrolling elem ", el);
    if (el instanceof Window) {
        el.scrollTo({ top: offset, left: 0, behavior: "smooth" });
            await waitForScrollEnd(el);  
    } else if (typeof el.scrollTo === "function") {
        el.scrollTo({ top: offset, left: 0, behavior: "smooth" });
            await waitForScrollEnd(el);  
    } else {
        console.warn("scrollTo: The element does not support scrolling.", el);
    }
}
window.scrollElementTo = scrollElementTo;

async function waitForScrollEnd(el) {
  if (el instanceof Window) {
     return new Promise((resolve) => {
        let scrollEndTimer;
        const handleScroll = () => {
        clearTimeout(scrollEndTimer);
        scrollEndTimer = setTimeout(() => {
            window.removeEventListener("scroll", handleScroll);
            resolve();
        }, 100);
        };
        window.addEventListener("scroll", handleScroll, { passive: true });
        handleScroll();
    });
  } else {
   return new Promise((resolve) => {
        let scrollEndTimer;
        const handleScroll = () => {
        clearTimeout(scrollEndTimer);
        scrollEndTimer = setTimeout(() => {
            el.removeEventListener("scroll", handleScroll);
            resolve();
        }, 100);
        };
        el.addEventListener("scroll", handleScroll, { passive: true });
        handleScroll();
    });
  }
}
window.waitForScrollEnd = waitForScrollEnd;

async function processDom(chunksSeen) {
  const { chunk, chunksArray } = await pickChunk(chunksSeen);
  const container = window;
  const { outputString, selectorMap } = await processElements(chunk, true, 0, container);

//   console.log("Extracted DOM elements: ", outputString);
  return { outputString, selectorMap, chunk, chunks: chunksArray };
}
window.processDom = processDom;

async function processCurrentChunk() {
  const container = window;
  const { outputString, selectorMap } = await processElements(0, false, 0, container);

//   console.log("Extracted DOM elements: ", outputString);
  return { outputString, selectorMap };
}
window.processCurrentChunk = processCurrentChunk;

async function processAllDomWithoutScrolling() {
  return await processAllOfDom(true);
}
window.processAllDomWithoutScrolling = processAllDomWithoutScrolling;

async function processAllOfDom(allowOffscreen = false) {
//   console.log("Processing all of DOM");
  const mainScrollable = getScrollableElements(1)[0];
  const container = mainScrollable === document.documentElement ? window : mainScrollable;
  const viewportHeight = getViewportHeight(container);
  const documentHeight = getScrollHeight(container);
  const totalChunks = Math.ceil(documentHeight / viewportHeight);
  let index = 0;
  const results = [];
  for (let chunk = 0; chunk < totalChunks; chunk++) {
    const result = await processElements(chunk, allowOffscreen ? false : true, index, container, allowOffscreen);
    results.push(result);
    index += Object.keys(result.selectorMap).length;
  }
  await scrollElementTo(container, 0);
  const allOutputString = results.map((result) => result.outputString).join("");
  const allSelectorMap = results.reduce((acc, result) => ({ ...acc, ...result.selectorMap }), {});

//   console.log("All DOM elements: ", allOutputString);
  return { outputString: allOutputString, selectorMap: allSelectorMap };
}
window.processAllOfDom = processAllOfDom;

async function scrollToChunk(chunk) {
//   console.log("Processing all of DOM");
  const mainScrollable = getScrollableElements(1)[0];
  const container = mainScrollable === document.documentElement ? window : mainScrollable;
  const viewportHeight = getViewportHeight(container);
  const documentHeight = getScrollHeight(container);
  const totalChunks = Math.ceil(documentHeight / viewportHeight);
  const totalScrollHeight = getScrollHeight(container);
  const chunkHeight = viewportHeight * chunk;
  const maxScrollTop = totalScrollHeight - viewportHeight;
  const offsetTop = Math.min(chunkHeight, maxScrollTop);

  if (chunk <= totalChunks) {
    console.time("processElements:scroll");
    await scrollElementTo(container, offsetTop);
    console.timeEnd("processElements:scroll");
  }
}
window.scrollToChunk = scrollToChunk;

async function processElements(chunk, scrollToChunk = true, indexOffset = 0, container, allowOffscreen = false) {
  console.time("processElements:total");
  container = container || window;
  const viewportHeight = getViewportHeight(container);
  const totalScrollHeight = getScrollHeight(container);
  const chunkHeight = viewportHeight * chunk;
  const maxScrollTop = totalScrollHeight - viewportHeight;
  const offsetTop = Math.min(chunkHeight, maxScrollTop);

  const xpathCache = window.xpathCache || new Map();

  if (scrollToChunk) {
    console.time("processElements:scroll");
    await scrollElementTo(container, offsetTop);
    console.timeEnd("processElements:scroll");
  }

//   console.log("Generating candidate elements");
  console.time("processElements:findCandidates");
  const DOMQueue = [...document.body.childNodes];
  const candidateElements = [];

  while (DOMQueue.length > 0) {
    const element = DOMQueue.pop();
    let shouldAddElement = false;
    if (element && isElementNode(element)) {
      const childrenCount = element.childNodes.length;
      for (let i = childrenCount - 1; i >= 0; i--) {
        DOMQueue.push(element.childNodes[i]);
      }
      if (isInteractiveElement(element) && isActive(element) && isVisible(element, allowOffscreen)) {
        shouldAddElement = true;
      }
      if (isLeafElement(element) && isActive(element) && isVisible(element, allowOffscreen)) {
        shouldAddElement = true;
      }
    }
    if (element && isTextNode(element) && isTextVisible(element, allowOffscreen)) {
      shouldAddElement = true;
    }
    if (shouldAddElement) {
      candidateElements.push(element);
    }
  }
  console.timeEnd("processElements:findCandidates");

  const selectorMap = {};
  let outputString = "";
//   console.log("Processing candidate elements: ", candidateElements.length);
  console.time("processElements:processCandidates");

  const xpathLists = await Promise.all(candidateElements.map(async (element) => {
    if (xpathCache.has(element)) {
      return xpathCache.get(element);
    }
    const xpaths = await generateXPathsForElement(element);
    xpathCache.set(element, xpaths);
    return xpaths;
  }));

  candidateElements.forEach((element, index) => {
    const xpaths = xpathLists[index];
    let elementOutput = "";
    if (isTextNode(element)) {
      const textContent = element.textContent?.trim();
      if (textContent) {
        elementOutput += "Text: " + (index + indexOffset) + ":" + textContent + "\\n";
      }
    } else if (isElementNode(element)) {
      const tagName = element.tagName.toLowerCase();
      const attributes = collectEssentialAttributes(element);
      const openingTag = "<" + tagName + (attributes ? " " + attributes : "") + ">";
      const closingTag = "</" + tagName + ">";
      let textContent = element.textContent?.trim() || "";
      
      // Add current value for form input elements
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
        const currentValue = element.value || '';
        if (currentValue) {
          textContent = 'value="' + currentValue + '"';
        }
      }
      
      elementOutput += "Element: " + (index + indexOffset) + ":" + openingTag + textContent + closingTag + "\\n";
    }
    outputString += elementOutput;
    selectorMap[index + indexOffset] = xpaths;
  });
  console.timeEnd("processElements:processCandidates");
  console.timeEnd("processElements:total");

  window.xpathCache = xpathCache;

  return { outputString, selectorMap };
}
window.processElements = processElements;

function collectEssentialAttributes(element) {
  const essentialAttributes = [
    "id", "class", "href", "src", "aria-label", "aria-name",
    "aria-role", "aria-description", "aria-expanded", "aria-haspopup",
    "type", "value"
  ];

  const attrs = essentialAttributes
    .map(attr => {
      const value = element.getAttribute(attr);
      return value ? (attr) + '="' + (value) + '"' : "";
    })
    .filter(attr => attr !== "");

  Array.from(element.attributes).forEach(attr => {
    if (attr.name.startsWith("data-")) {
      attrs.push("" + (attr.name) + '="' + (attr.value) + '"');
    }
  });

  return attrs.join(" ");
}
window.collectEssentialAttributes = collectEssentialAttributes;

function storeDOM() {
  const originalDOM = document.body.cloneNode(true);
//   console.log("DOM state stored.");
  return originalDOM.outerHTML;
}
window.storeDOM = storeDOM;

function restoreDOM(storedDOM) {
//   console.log("Restoring DOM");
  if (storedDOM) {
    document.body.innerHTML = storedDOM;
  } else {
    console.error("No DOM state was provided.");
  }
}
window.restoreDOM = restoreDOM;

function createTextBoundingBoxes() {
  const style = document.createElement("style");
  document.head.appendChild(style);
  if (style.sheet) {
    style.sheet.insertRule(
      ".browserable-highlighted-word, .browserable-space { border: 0px solid orange; display: inline-block !important; visibility: visible;}", 0
    );

    style.sheet.insertRule(
      "code .browserable-highlighted-word, code .browserable-space, pre .browserable-highlighted-word, pre .browserable-space { white-space: pre-wrap; display: inline !important;}", 1
    );
  }

  function applyHighlighting(root) {
    root.querySelectorAll("body *").forEach(element => {
      if (element.closest(".browserable-nav, .browserable-marker")) return;
      if (["SCRIPT", "STYLE", "IFRAME", "INPUT"].includes(element.tagName)) return;

      const childNodes = Array.from(element.childNodes);
      childNodes.forEach(node => {
        if (node.nodeType === 3 && node.textContent.trim().length > 0) {
          const textContent = node.textContent.replace(/\\u00A0/g, " ");
          const tokens = textContent.split(/(\\s+)/g);
          const fragment = document.createDocumentFragment();
          const parentIsCode = element.tagName === "CODE";

          tokens.forEach(token => {
            const span = document.createElement("span");
            span.textContent = token;
            if (parentIsCode) {
              span.style.whiteSpace = "pre-wrap";
              span.style.display = "inline";
            }
            span.className = token.trim().length === 0 ? "browserable-space" : "browserable-highlighted-word";
            fragment.appendChild(span);
          });

          if (fragment.childNodes.length > 0 && node.parentNode) {
            element.insertBefore(fragment, node);
            node.remove();
          }
        }
      });
    });
  }

  applyHighlighting(document);

  document.querySelectorAll("iframe").forEach(iframe => {
    try {
      iframe.contentWindow?.postMessage({ action: "highlight" }, "*");
    } catch (error) {
      console.error("Error accessing iframe content: ", error);
    }
  });
}
window.createTextBoundingBoxes = createTextBoundingBoxes;

function getElementBoundingBoxesMaster(xpaths) {
  const boundingBoxesMap = {};
  for (const xpath of xpaths) {
    const boundingBoxes = getElementBoundingBoxes(xpath);
    boundingBoxesMap[xpath] = boundingBoxes;
  }
  return boundingBoxesMap;
}
window.getElementBoundingBoxesMaster = getElementBoundingBoxesMaster;

function getElementBoundingBoxes(xpath) {
  const element = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  if (!element) return [];

  function isValidText(text) {
    return text && text.trim().length > 0;
  }

  let dropDownElem = element.querySelector("option[selected]") || element.querySelector("option");
  if (dropDownElem) {
    const elemText = dropDownElem.textContent || "";
    if (isValidText(elemText)) {
      const parentRect = element.getBoundingClientRect();
      return [{
        text: elemText.trim(),
        top: parentRect.top + window.scrollY,
        left: parentRect.left + window.scrollX,
        width: parentRect.width,
        height: parentRect.height
      }];
    } else {
      return [];
    }
  }

  let placeholderText = "";
  if (["input", "textarea"].includes(element.tagName.toLowerCase()) && element.placeholder) {
    placeholderText = element.placeholder;
  } else if (element.tagName.toLowerCase() === "img") {
    placeholderText = element.alt || "";
  }

  const words = element.querySelectorAll(".browserable-highlighted-word");
  const boundingBoxes = Array.from(words).map(word => {
    const rect = word.getBoundingClientRect();
    return {
      text: word.innerText || "",
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      height: rect.height * 0.75
    };
  }).filter(box => box.width > 0 && box.height > 0 && box.top >= 0 && box.left >= 0 && isValidText(box.text));

  if (boundingBoxes.length === 0) {
    const elementRect = element.getBoundingClientRect();
    return [{
      text: placeholderText,
      top: elementRect.top + window.scrollY,
      left: elementRect.left + window.scrollX,
      width: elementRect.width,
      height: elementRect.height * 0.75
    }];
  }
  return boundingBoxes;
}
window.getElementBoundingBoxes = getElementBoundingBoxes;


async function debugDom(showChunks = false) {
  window.chunkNumber = 0;

  const result = await processElements(window.chunkNumber);
  const multiSelectorMap = result.selectorMap;

  const selectorMap = multiSelectorMapToSelectorMap(multiSelectorMap);
  drawChunk(selectorMap, showChunks);
}
window.debugDom = debugDom;


function multiSelectorMapToSelectorMap(multiSelectorMap) {
  const selectorMap = {};
  for (const key in multiSelectorMap) {
    if (multiSelectorMap.hasOwnProperty(key)) {
      selectorMap[Number(key)] = multiSelectorMap[key][0];
    }
  }
  return selectorMap;
}
window.multiSelectorMapToSelectorMap = multiSelectorMapToSelectorMap;

function drawChunk(selectorMap, showChunks) {
  if (!showChunks) return;
  cleanupMarkers();

  Object.values(selectorMap).forEach(function(selector) {
    const element = document.evaluate(
      selector,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    ).singleNodeValue;

    if (element) {
      let rect;
      if (element.nodeType === Node.ELEMENT_NODE) {
        rect = element.getBoundingClientRect();
      } else {
        const range = document.createRange();
        range.selectNodeContents(element);
        rect = range.getBoundingClientRect();
      }

      const overlay = document.createElement("div");
      overlay.style.position = "absolute";
      overlay.style.left = (rect.left + window.scrollX) + "px";
      overlay.style.top = (rect.top + window.scrollY) + "px";
      overlay.style.padding = "2px"; // Add 2px of padding to the overlay
      overlay.style.width = rect.width + "px";
      overlay.style.height = rect.height + "px";
      overlay.style.backgroundColor = "grey";
      overlay.className = "browserable-marker";
      overlay.style.opacity = "0.3";
      overlay.style.zIndex = "1000000000";
      overlay.style.border = "1px solid";
      overlay.style.pointerEvents = "none";
      document.body.appendChild(overlay);
    }
  });
}
window.drawChunk = drawChunk;

async function cleanupDebug() {
  cleanupMarkers();
}
window.cleanupDebug = cleanupDebug;

function cleanupMarkers() {
  const markers = document.querySelectorAll(".browserable-marker");
  markers.forEach(function(marker) {
    marker.remove();
  });
}
window.cleanupMarkers = cleanupMarkers;




//----------------------------------------------------------------------------------------//





function scrollToText(text) {
  try {
  
    const pathMap = getAllElements();
    const allElements = Object.values(pathMap);
    const element = allElements.find(element => (element.text || "").trim().toLowerCase() === (text || "").trim().toLowerCase());

    if (!element) {
      console.error("Element not found", text);
      sendDataToElectron({ tabId: window.tabID, event: "scroll-to-text", data: { error, text }, callerId }); 
      return;
    }

    window.scrollBy(0, element.element.getBoundingClientRect().top - 100);
  } catch (error) {
    console.error("Error scrolling to text", error);
  }
}


function scrollPage(direction, callerId) {
  // get window height
  const windowHeight = window.innerHeight;
  if (direction === 'up') {
    window.scrollBy(0, -windowHeight); // Scroll up by 100px
  } else if (direction === 'down') {
    window.scrollBy(0, windowHeight); // Scroll down by 100px
  }


  // wait for 2 seconds for the scroll to complete
  setTimeout(() => {
      const didPageReachBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight;
      const didPageReachTop = window.scrollY <= 0;
  }, 2000);
}


function clickOnBoundaryBox(number) {
  try {
    // draw boundary box around clickable element
    const pathMap = findClickableElements();
    try {
      // click on clickable element
      clickElementByPath(pathMap, number);
    } catch (e) {
      console.error("Error clicking on boundary box", e);
    }
    // cleanup boundary boxes around clickable elements
    cleanupMarkings(pathMap);
  } catch (e) {
    console.error("Error clicking on boundary box", e);
  }
}

function clickOnPage(x, y) {
  document.elementFromPoint(x, y).click();
}

// Only clickable elements
async function clickOnText(text) {
  try {
    // draw boundary box around clickable element
    const pathMap = findClickableElements();

    try {
      // click on clickable element
      clickElementByText(pathMap, text);
    } catch (e) {
      console.error("Error clicking on boundary box", e);
    }
    // cleanup boundary boxes around clickable elements
    cleanupMarkings(pathMap);
  } catch (e) {
    console.error("Error clicking on boundary box", e);
  }
}


// All elements
async function clickOnAnyText(text) {
  try {
    // draw boundary box around clickable element
    const pathMap = getAllElements();

    try {
      // click on clickable element
      clickElementByText(pathMap, text);
    } catch (e) {
      console.error("Error clicking on any text", e);
    }
  } catch (e) {
    console.error("Error clicking on any text", e);
  }
}


async function typeIntoBoundaryBox(text, elemNumber) {

  try {
    // draw boundary box around clickable element
    const pathMap = findClickableElements();

    try {

      // get the element
      const element = pathMap[elemNumber].element;

      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const event = new KeyboardEvent('keydown', { key: char });
        element.dispatchEvent(event);
        const event2 = new KeyboardEvent('keyup', { key: char });
        element.dispatchEvent(event2);
      }
      element.value = text;
    } catch (e) {
      console.error("Error clicking on boundary box", e);
    }
    // cleanup boundary boxes around clickable elements
    cleanupMarkings(pathMap);
  } catch (e) {
    console.error("Error clicking on boundary box", e);
  }
}


// Function to generate a unique path to an element
function getUniquePath(element) {
    const path = [];
    while (element && element.parentElement) {
        let selector = element.tagName.toLowerCase();
        
        if (element.id) {
            return "#" + element.id;
        }
        
        const parent = element.parentElement;
        if (!parent) break;
        
        const similarSiblings = Array.from(parent.children).filter(
            child => child.tagName === element.tagName
        );
        
        if (similarSiblings.length > 1) {
            const index = similarSiblings.indexOf(element) + 1;
            selector += ":nth-of-type(" + index + ")";
        }
        
        path.unshift(selector);
        element = parent;
    }
    return path.join(' > ');
};

// Function to get random color
function getRandomColor() {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
        color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
};

// Function to check if element is inside another clickable element
function isInsideClickable(element) {
    let parent = element.parentElement;
    while (parent) {
        if (parent.tagName.toLowerCase() === 'a' || 
            parent.tagName.toLowerCase() === 'button' ||
            (parent.tagName.toLowerCase() === 'input' && 
             ['submit', 'button', 'reset'].includes(parent.type)) ||
            parent.hasAttribute('onclick') ||
            window.getComputedStyle(parent).cursor === 'pointer') {
            return true;
        }
        parent = parent.parentElement;
    }
    return false;
};

function isElementInVisibleViewport(element) {
  const rect = element.getBoundingClientRect();
  return rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
}

function isElementVisible(element) {
  const fourChecks = element.checkVisibility();

  return fourChecks;

  if (!fourChecks) {
    return false;
  }

  // now lets see if its actually visible or not
  const rectPos = element.getBoundingClientRect();
  var result = 0;
  // if (element == document.elementFromPoint(rectPos.left + 1, rectPos.top + 1)) {
  //     result++;
  // }
  // if (element == document.elementFromPoint(rectPos.left + 1, rectPos.bottom - 1)) {
  //     result++;
  // }
  // if (element == document.elementFromPoint(rectPos.right - 1, rectPos.top)) {
  //     result++;
  // }
  // if (element == document.elementFromPoint(rectPos.right - 1, rectPos.bottom - 1)) {
  //     result++;
  // }

  // middle of the element should be visible
  const middleElement = document.elementFromPoint(rectPos.left + rectPos.width / 2, rectPos.top + rectPos.height / 2);

  if (middleElement == element) {
    return true;
  } else {
    while (middleElement.parentElement) {
      middleElement = middleElement.parentElement;
      if (middleElement == element) {
        return true;
      }
    }
  }

  return false;

  // OLD CODE BELOW

  // element should not have display: none or visibility: hidden
  // and any of the elements parent until it reaches the body should not have display: none or visibility: hidden
  if (element && element.style && (element.style.display === "none" || element.style.visibility === "hidden")  ) {
    return false;
  }
  let parent = element.parentElement;
  while (parent) {
    if (parent.style.display === "none" || parent.style.visibility === "hidden") {
      return false;
    }
    parent = parent.parentElement;
  }
  return true;
}


// Create a container for all markers
function createMarkersContainer() {
    const container = document.createElement('div');
    container.id = 'clickable-markers-container';
    container.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2147483647;";
    document.body.appendChild(container);
    return container;
};

function getAllElements() {
    const clickableElements = new Set();
    const pathMap = {};
    let counter = 1;
    
    // Find all potential clickable elements
    const elements = document.querySelectorAll('*');
    elements.forEach(element => {
        try {
            if (!element || !element.tagName) return;
            
            const tagName = element.tagName.toLowerCase();
            clickableElements.add(element);
        } catch (e) {
            console.debug('Skipped element due to error:', e);
        }
    });
    
    // Mark elements and create path map
    clickableElements.forEach(element => {
        try {
            const originalStyle = element.style.cssText;
            
            // Store the path and reference to the element
            pathMap[counter] = {
                path: getUniquePath(element),
                text: (getElementVisibleText(element) || "").trim(),
                originalStyle,
                element,
            };
            
            counter++;
        } catch (e) {
            console.debug('Skipped marking element due to error:', e);
        }
    });
    
    // Update positions on scroll and resize
    // window.addEventListener('scroll', updateMarkerPositions);
    // window.addEventListener('resize', updateMarkerPositions);
    
    return pathMap;
}

function findClickableElementsLight() {
  const pathMap = findClickableElements();
  window.TEMP_PATH_MAP = pathMap;
  const lightPathMap = {};
  Object.keys(pathMap).forEach((key) => {
    lightPathMap[key] = {
      path: pathMap[key].path,
      text: pathMap[key].text,
      originalStyle: pathMap[key].originalStyle,
      url: pathMap[key].url,
    };
  });
  return lightPathMap;
}

// Main function to find and mark clickable elements
function findClickableElements() {
    const clickableElements = new Set();
    const pathMap = {};
    let counter = 1;
    
    const markersContainer = createMarkersContainer();
    
    const elements = document.querySelectorAll('*');
    elements.forEach(element => {
        try {
            if (!element || !element.tagName) return;
            
            const tagName = element.tagName.toLowerCase();
            
            if (isInsideClickable(element)) return;
            
            const isNaturallyClickable = 
                tagName === 'a' || 
                tagName === 'button' ||
                tagName === 'input' ||
                tagName === 'textarea';
            
            let hasClickProperties = false;
            try {
                hasClickProperties = element.hasAttribute('onclick') || 
                                   window.getComputedStyle(element).cursor === 'pointer';
            } catch (e) {
                // Ignore style-related errors
            }

            if (!isElementInVisibleViewport(element)) return;
            if (!isElementVisible(element)) return;
            
            if (isNaturallyClickable || hasClickProperties) {
                clickableElements.add(element);
            }
        } catch (e) {
            console.debug('Skipped element due to error:', e);
        }
    });
    
    const markers = [];
    
    const createNumberIndicator = (color, number) => {
        const indicator = document.createElement('div');
        indicator.textContent = number;
        indicator.style.cssText = "background: " + color + "; color: white; padding: 2px 5px; border-radius: 3px; font-size: 12px; position: absolute; font-family: Arial, sans-serif; font-weight: bold; text-shadow: 1px 1px 1px rgba(0,0,0,0.5); box-shadow: 0 1px 3px rgba(0,0,0,0.3); white-space: nowrap; pointer-events: none; z-index: 2147483647;";
        return indicator;
    };

    const updateMarkerPositions = () => {
        markers.forEach(({ element, label }) => {
            try {
                const rect = element.getBoundingClientRect();
                const labelWidth = 50; // Estimated label width
                const labelHeight = 20; // Estimated label height

                // Helper function to check if a position collides with any boundary box
                const isColliding = function(x, y) {
                    const labelRect = {
                        left: x,
                        top: y,
                        right: x + labelWidth,
                        bottom: y + labelHeight
                    };

                    return markers.some(function({ element: otherElement }) {
                        const otherRect = otherElement.getBoundingClientRect();
                        return !(
                            labelRect.right < otherRect.left ||
                            labelRect.left > otherRect.right ||
                            labelRect.bottom < otherRect.top ||
                            labelRect.top > otherRect.bottom
                        );
                    });
                };

                // Check if the box is sufficiently large
                const isLargeBox = rect.width >= labelWidth * 2 && rect.height >= labelHeight * 2 && (rect.width >= labelWidth * 4 || rect.height >= labelHeight * 4);
                const isSensible = rect.width >= labelWidth * 1.75 || rect.height >= labelHeight * 1.75;

                // Define potential positions
                const positions = [];

                // If the box is very large, prioritize inside-the-box positions
                if (isLargeBox) {
                    positions.push(
                        { x: rect.left + 5, y: rect.bottom - labelHeight - 5 }, // bottom left inside
                    );
                }

                // Add fallback positions outside the box
                let fallbacks = [
                    { x: rect.left - labelWidth - 5, y: rect.top + (rect.height - labelHeight) / 2 }, // Left
                    { x: rect.right + 5, y: rect.top + (rect.height - labelHeight) / 2 }, // Right
                    { x: rect.left + (rect.width - labelWidth) / 2, y: rect.top - labelHeight - 5 }, // Above
                    { x: rect.left + (rect.width - labelWidth) / 2, y: rect.bottom + 5 } // Below
                ];

                fallbacks = fallbacks.filter(pos => 
                        pos.x >= 0 &&
                        pos.y >= 0 &&
                        pos.x + labelWidth <= window.innerWidth &&
                        pos.y + labelHeight <= window.innerHeight &&
                        !isColliding(pos.x, pos.y)
                );
              


                if (isSensible) {
                  // dead center of the element
                  positions.push({
                      x: rect.left + (rect.width - labelWidth) / 2,
                      y: rect.top + (rect.height - labelHeight) / 2
                  });
                }

                // worst case option
                positions.push({
                  x: rect.left + (rect.width - labelWidth) / 2,
                  y: rect.bottom + 5
                })

                const selectedPosition = positions[0];

                // Update label position
                label.style.left = (selectedPosition.x + window.scrollX) + 'px';
                label.style.top = (selectedPosition.y + window.scrollY) + 'px';
            } catch (e) {
                console.debug('Error positioning label:', e);
            }
        });
    };

    // Adjust marker creation to use a single label
    clickableElements.forEach(function(element) {
        try {
            var color = getRandomColor();
            var originalStyle = element.style.cssText;

            element.style.cssText = originalStyle + '; border: 4px solid ' + color + ' !important; position: relative !important;';

            var label = createNumberIndicator(color, counter);

            markersContainer.appendChild(label);

            markers.push({
                element: element,
                label: label
            });

            var elementUrl = '';
            if (element.tagName === 'A') {
                elementUrl = element.href;
            }

            pathMap[counter] = {
                path: getUniquePath(element),
                text: (getElementVisibleText(element) || '').trim(),
                originalStyle: originalStyle,
                // element: element,
                label: label,
                url: elementUrl
            };

            counter++;
        } catch (e) {
            console.debug('Skipped marking element due to error:', e);
        }
    });

    updateMarkerPositions();


    
    return pathMap;
}

function getElementVisibleText(element) {
    // Handle null/undefined cases
    if (!element) return '';

    // Handle input elements
    if (element.tagName === 'INPUT') {
        switch (element.type.toLowerCase()) {
            case 'button':
            case 'submit':
            case 'reset':
                return element.value || element.innerText || '';
            case 'text':
            case 'password':
            case 'email':
            case 'tel':
            case 'number':
            case 'search':
            case 'url':
                return element.value || '';
            case 'checkbox':
            case 'radio':
                return '';  // Usually these don't have visible text
            default:
                return element.value || '';
        }
    }

    // Handle textarea
    if (element.tagName === 'TEXTAREA') {
        return element.value || '';
    }

    // Handle select elements
    if (element.tagName === 'SELECT') {
        const selectedOption = element.options[element.selectedIndex];
        return selectedOption ? selectedOption.text : '';
    }

    // Handle buttons
    if (element.tagName === 'BUTTON') {
        return element.innerText || element.textContent || '';
    }

    // Special cases for elements that might have alternative text
    if (element.tagName === 'IMG') {
        return element.alt || '';
    }

    if (element.tagName === 'A') {
        return element.innerText || element.textContent || '';
    }

    // For elements with aria-label
    if (element.hasAttribute('aria-label')) {
        return element.getAttribute('aria-label');
    }

    // Handle elements with contentEditable
    if (element.isContentEditable) {
        return element.innerText || element.textContent || '';
    }

    // Get text content while handling hidden elements
    let text = '';
    for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const style = window.getComputedStyle(node);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
                text += getElementVisibleText(node);
            }
        }
    }

    // If no child nodes, get direct text content
    if (!text && element.nodeType === Node.ELEMENT_NODE) {
        text = element.innerText || element.textContent || '';
    }

    return text.trim();
}

// Function to click element by path
function clickElementByPath(pathMap, number) {
    try {
        const data = pathMap[number];
        if (data && data.element) {
            let elementToClick = data.element;
            while (elementToClick) {
                        // console.log("elementToClick", elementToClick, elementToClick.tagName, elementToClick.click);
                if (elementToClick.click) {
                    elementToClick.click();

                    if (elementToClick.select) {
                        elementToClick.select();
                    }
                    return true;
                }
                elementToClick = elementToClick.parentElement;
            }
        }
    } catch (e) {
        console.debug('Error clicking element:', e);
    }
    return false;
};

// Function to click element by text
function clickElementByText(pathMap, text) {
    try {
        Object.keys(pathMap).forEach(number => {
          const data = pathMap[number];
          if (data && (data.text || "").trim().toLowerCase() === (text || "").trim().toLowerCase()) {
            clickElementByPath(pathMap, number);
            return true;
          }
        });
    } catch (e) {
        console.debug('Error clicking element:', e);
    }
    return false;
};


function cleanupMarkingsLight() {
  if (!window.TEMP_PATH_MAP) return;
  cleanupMarkings(window.TEMP_PATH_MAP);
  window.TEMP_PATH_MAP = null;
}

// Function to restore original styles
function cleanupMarkings(pathMap) {
    if (!pathMap) return;
    
    // Remove the markers container
    const markersContainer = document.getElementById('clickable-markers-container');
    if (markersContainer) {
        markersContainer.remove();
    }
    
    Object.keys(pathMap).forEach((number) => {
        const data = pathMap[number];
        try {
            if (data.element) {
                data.element.style.cssText = data.originalStyle;
            }
        } catch (e) {
            console.debug('Error cleaning up element:', e);
        }
    });
    
    // window.removeEventListener('scroll', updateMarkerPositions);
    // window.removeEventListener('resize', updateMarkerPositions);
};


// DOC TO MD
function convertToMarkdown(element, indent = '') {
    if (!element || !element.checkVisibility || !element.checkVisibility() || 
        ['SCRIPT', 'STYLE', 'IMG'].includes(element.tagName)) {
        return '';
    }

    const getPureText = (el) => {
    return Array.from(el.childNodes)
        .filter(node => 
            node.nodeType === Node.TEXT_NODE && 
            node.textContent.trim() !== ''
        )
        .map(node => node.textContent.trim())
        .join(' ');
    };

    let markdown = '';

    if (element.tagName.match(/^H[1-6]$/)) {
        const directText = getPureText(element);
        const level = element.tagName.slice(1);

        const childElements = Array.from(element.children)
            .filter(child => !['IMG', 'SPAN'].includes(child.tagName));

        if (childElements.length > 0) {
          markdown += getPureText(element);
          childElements.forEach(child => {
              markdown += convertToMarkdown(child, indent + '  ');
          });
        } else {
          markdown += indent + '#'.repeat(parseInt(level)) + " " + element.textContent.trim() + "\\n";  
        }
      
        return markdown;
    }

    if (element.tagName === 'A') {
        const directText = getPureText(element);
        let href = element.href;
        
        const currentDomain = window.location.origin;
        if (href.startsWith(currentDomain)) {
            href = href.replace(currentDomain, '');
        }

        if (href.length > 80) {
          // this is a crazy site with too much tracking. let's skip URL
          href = "";
        }

        const childElements = Array.from(element.children)
            .filter(child => !['IMG', 'SPAN'].includes(child.tagName));

        if (childElements.length > 0) {
            markdown += indent + href + "\\n";
            childElements.forEach(child => {
                markdown += convertToMarkdown(child, indent + '  ');
            });
        } else if (directText) {
            if (href) {
                markdown += indent + "[" + directText + "](" + href + ")\\n";
            } else {
                markdown += indent + directText + "\\n";
            }
        }
        return markdown;
    }

    if (element.tagName === 'SPAN') {
        const text = getPureText(element);
        if (text) {
            markdown += indent + text + "\\n";
            return markdown;
        }
    }

    if (element.tagName === 'P') {
        markdown += indent + element.textContent.trim() + "\\n";
        return markdown;
    }

    if (element.tagName === 'UL') {
        const nonEmptyListItems = Array.from(element.children)
            .map(li => getPureText(li))
            .filter(text => text.length > 0);
        
        if (nonEmptyListItems.length > 0) {
            nonEmptyListItems.forEach(text => {
                markdown += indent + "- " + text + "\\n";
            });
        }
        return markdown;
    }

    for (let child of element.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
            markdown += convertToMarkdown(child, indent + '  ');
        }
    }

    return markdown;
}


function DocToMD(doc) {
    return convertToMarkdown(doc)
        .split('\\n')
        .filter(line => line.trim().length > 0)
        .join('\\n');
}

// console.log("webview.js loaded");

`;

async function getTabIdOfPage(page) {
    try {
        await ensureWebviewJSInjected(page);

        const tabId = await page.evaluate(() => {
            return window.generatedUniqueId;
        });

        return tabId;
    } catch (e) {
        console.error(e);
        return [];
    }
}

async function getBrowserTabsAndMetaInformation({ context }) {
    // get all tabs
    const pages = await context.pages();
    let tabsInfo = [];

    for (const [index, page] of pages.entries()) {
        const tabId = await getTabIdOfPage(page);
        tabsInfo.push({
            url: page.url(),
            tabId: tabId,
            index: index,
        });
    }

    return {
        tabs: tabsInfo,
        tabsString: tabsInfo
            .map((tab) => `Tab ID: ${tab.tabId}, URL: ${tab.url}`)
            .join("\n"),
    };
}

async function extractLLMHelper({
    instructions,
    schema,
    previouslyExtractedContent,
    domElements,
    chunksSeen,
    chunksTotal,
    useTextExtract = true,
    jarvis,
    runId,
    nodeId,
    threadId,
    imageUrl,
    privateImageUrl,
}) {
    const isRunActive = await jarvis.isRunActive({
        runId,
        flowId: jarvis.flow_id,
    });

    if (!isRunActive) {
        return {
            completed: false,
            extractedContent: "",
            summaryOfExtractedContent: "Run is not active.",
        };
    }

    const messages = browserablePrompts.buildExtractLLMPrompt({
        instructions,
        schema,
        previouslyExtractedContent,
        domElements,
        chunksSeen,
        chunksTotal,
        useTextExtract,
        imageUrl,
        privateImageUrl,
    });

    const response = await callOpenAICompatibleLLMWithRetry({
        messages,
        models: [
            "gemini-2.5-flash",
            "deepseek-chat",
            "gpt-4o-mini",
            "claude-3-5-haiku",
            "qwen-plus",
        ],
        metadata: {
            runId,
            nodeId,
            agentCode: this.CODE,
            usecase: "extract_content",
            flowId: jarvis.flow_id,
            accountId: jarvis.account_id,
            threadId,
        },
        max_attempts: 3,
    });

    let extractedContent = response.extractedContent;

    if (typeof extractedContent === "object") {
        extractedContent = JSON.stringify(extractedContent, null, 2);
    }

    await jarvis.updateNodeDebugLog({
        runId,
        nodeId,
        threadId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "Extracted content.",
                        associatedData: [
                            {
                                type: "markdown",
                                markdown: extractedContent,
                                name: "Extracted Content",
                            },
                            {
                                type: "image",
                                url: imageUrl,
                                name: "Screenshot",
                            },
                            {
                                type: "code",
                                name: "Page",
                                code: {
                                    domElements,
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    });

    await jarvis.updateNodeUserLog({
        runId,
        nodeId,
        threadId,
        messages: [
            {
                role: "assistant",
                content: "Extracted content.",
            },
        ],
    });

    const isRunActive2 = await jarvis.isRunActive({
        runId,
        flowId: jarvis.flow_id,
    });

    if (!isRunActive2) {
        return {
            completed: false,
            extractedContent: "",
            summaryOfExtractedContent: "Run is not active.",
        };
    }

    const refineMessages = browserablePrompts.buildRefineExtractedContentPrompt(
        {
            instructions,
            previouslyExtractedContent,
            extractedContent,
            schema,
        }
    );

    const refineResponse = await callOpenAICompatibleLLMWithRetry({
        messages: refineMessages,
        models: [
            "gemini-2.5-flash",
            "deepseek-chat",
            "gpt-4o-mini",
            "claude-3-5-haiku",
            "qwen-plus",
        ],
        metadata: {
            runId,
            nodeId,
            agentCode: this.CODE,
            usecase: "refine_extracted_content",
            flowId: jarvis.flow_id,
            accountId: jarvis.account_id,
            threadId,
        },
        max_attempts: 3,
    });

    let refinedContent = refineResponse.extractedContent;

    if (typeof refinedContent === "object") {
        refinedContent = JSON.stringify(refinedContent, null, 2);
    }

    await jarvis.updateNodeDebugLog({
        runId,
        nodeId,
        threadId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "Refined content.",
                        associatedData: [
                            {
                                type: "markdown",
                                markdown: refinedContent,
                                name: "Refined Content",
                            },
                        ],
                    },
                ],
            },
        ],
    });

    await jarvis.updateNodeUserLog({
        runId,
        nodeId,
        threadId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "Refined content.",
                        associatedData: [
                            {
                                type: "markdown",
                                markdown: refinedContent,
                                name: "Refined Content",
                            },
                        ],
                    },
                ],
            },
        ],
    });

    const isRunActive3 = await jarvis.isRunActive({
        runId,
        flowId: jarvis.flow_id,
    });

    if (!isRunActive3) {
        return {
            completed: false,
            extractedContent: "",
            summaryOfExtractedContent: "Run is not active.",
        };
    }

    const metadataMessages = browserablePrompts.buildExtractionMetadataPrompt({
        instructions,
        refinedContent,
        chunksSeen,
        chunksTotal,
    });

    const metadataResponse = await callOpenAICompatibleLLMWithRetry({
        messages: metadataMessages,
        models: [
            "gemini-2.5-flash",
            "deepseek-chat",
            "gpt-4o-mini",
            "claude-3-5-haiku",
            "qwen-plus",
        ],
        metadata: {
            runId,
            nodeId,
            agentCode: this.CODE,
            usecase: "decide_if_extraction_is_complete",
            flowId: jarvis.flow_id,
            accountId: jarvis.account_id,
            threadId,
        },
        max_attempts: 3,
    });

    const { completed, summaryOfExtractedContent } = metadataResponse;

    await jarvis.updateNodeDebugLog({
        runId,
        nodeId,
        threadId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: `Decided if extraction is complete. Result: ${
                            completed ? "Yes" : "No"
                        }.`,
                        associatedData: [
                            {
                                type: "markdown",
                                markdown: summaryOfExtractedContent,
                                name: "Summary",
                            },
                        ],
                    },
                ],
            },
        ],
    });

    await jarvis.updateNodeUserLog({
        runId,
        nodeId,
        threadId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: `Decided if extraction is complete. Result: ${
                            completed ? "Yes" : "No"
                        }.`,
                        associatedData: [
                            {
                                type: "markdown",
                                markdown: summaryOfExtractedContent,
                                name: "Summary",
                            },
                        ],
                    },
                ],
            },
        ],
    });

    return {
        completed,
        extractedContent: refinedContent,
        summaryOfExtractedContent,
    };
}

async function actLLMHelper({
    action,
    expectationFromAction,
    domElements,
    steps,
    variables = {},
    jarvis,
    runId,
    nodeId,
    threadId,
    imageUrl,
    privateImageUrl,
}) {
    const messages = browserablePrompts.buildActLLMPrompt({
        action,
        expectationFromAction,
        domElements,
        steps,
        variables,
        imageUrl,
        privateImageUrl,
    });

    const response = await callOpenAICompatibleLLMWithRetry({
        messages,
        models: [
            "gemini-2.5-flash",
            "deepseek-chat",
            "deepseek-reasoner",
            "claude-3-5-sonnet",
            "gpt-4o",
            "qwen-plus",
        ],
        metadata: {
            runId,
            nodeId,
            agentCode: this.CODE,
            usecase: "decide_action_to_take",
            flowId: jarvis.flow_id,
            accountId: jarvis.account_id,
            threadId,
        },
        max_attempts: 5,
    });

    return response;
}

async function verifyActionHelper({
    action,
    steps,
    domElements,
    jarvis,
    runId,
    nodeId,
    imageUrl,
    privateImageUrl,
    threadId,
}) {
    const messages = browserablePrompts.buildVerifyActionPrompt({
        action,
        steps,
        domElements,
        imageUrl,
        privateImageUrl,
    });

    const response = await callOpenAICompatibleLLMWithRetry({
        messages,
        models: [
            "gemini-2.5-flash",
            "deepseek-chat",
            "deepseek-reasoner",
            "claude-3-5-sonnet",
            "gpt-4o",
            "qwen-plus",
        ],
        metadata: {
            runId,
            nodeId,
            agentCode: this.CODE,
            usecase: "verify_action_completion",
            flowId: jarvis.flow_id,
            accountId: jarvis.account_id,
            threadId,
        },
        max_attempts: 5,
    });

    return response;
}

async function verifyActionCompletion({
    action,
    completed,
    steps,
    page,
    jarvis,
    runId,
    nodeId,
    threadId,
    expectationFromAction,
}) {
    if (!completed) {
        return {
            completed: false,
        };
    }

    const isRunActive = await jarvis.isRunActive({
        runId,
        flowId: jarvis.flow_id,
    });

    if (!isRunActive) {
        return {
            completed: false,
        };
    }

    await waitForSettledDom(page);

    // take a screenshot
    const { success, imageUrl, privateImageUrl } = await screenshotHelper({
        page,
        runId,
        nodeId,
        jarvis,
    });

    const { outputString: domElements } = await processCurrentChunk(page);

    // const { outputString: domElements } = await processAllOfDom(page);

    const isRunActive2 = await jarvis.isRunActive({
        runId,
        flowId: jarvis.flow_id,
    });

    if (!isRunActive2) {
        return {
            completed: false,
        };
    }

    let actionCompleted = false;
    if (completed) {
        const verifyResponse = await verifyActionHelper({
            action,
            steps,
            domElements,
            jarvis,
            runId,
            nodeId,
            imageUrl,
            privateImageUrl,
            threadId,
            jarvis,
            expectationFromAction,
        });

        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Verifying if action (${action}) is completed using the current page. Result: ${
                                verifyResponse.completed ? "Yes" : "No"
                            }.`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: verifyResponse.reason,
                                    name: "Reason",
                                },
                                {
                                    type: "image",
                                    url: imageUrl,
                                    name: "Screenshot",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        await jarvis.updateNodeUserLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Verifying if action (${action}) is completed using the current page. Result: ${
                                verifyResponse.completed ? "Yes" : "No"
                            }.`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: verifyResponse.reason,
                                    name: "Reason",
                                },
                                {
                                    type: "image",
                                    url: imageUrl,
                                    name: "Screenshot",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        actionCompleted = verifyResponse.completed;

        if (!actionCompleted) {
            const isRunActive3 = await jarvis.isRunActive({
                runId,
                flowId: jarvis.flow_id,
            });

            if (!isRunActive3) {
                return {
                    completed: false,
                };
            }

            const { outputString: domElementsAll } =
                await processAllDomWithoutScrolling(page);

            const verifyResponseAll = await verifyActionHelper({
                action,
                steps,
                domElements: domElementsAll,
                jarvis,
                runId,
                nodeId,
                imageUrl,
                privateImageUrl,
                threadId,
            });

            await jarvis.updateNodeDebugLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: `Verifying if action (${action}) is completed using the entire page. Result: ${
                                    verifyResponseAll.completed ? "Yes" : "No"
                                }.`,
                                associatedData: [
                                    {
                                        type: "markdown",
                                        markdown: verifyResponseAll.reason,
                                        name: "Reason",
                                    },
                                    {
                                        type: "image",
                                        url: imageUrl,
                                        name: "Screenshot",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });

            await jarvis.updateNodeUserLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: `Verifying if action (${action}) is completed using the entire page. Result: ${
                                    verifyResponseAll.completed ? "Yes" : "No"
                                }.`,
                                associatedData: [
                                    {
                                        type: "markdown",
                                        markdown: verifyResponseAll.reason,
                                        name: "Reason",
                                    },
                                    {
                                        type: "image",
                                        url: imageUrl,
                                        name: "Screenshot",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });

            actionCompleted = verifyResponseAll.completed;

            if (!actionCompleted) {
                return {
                    completed: false,
                    reason: verifyResponseAll.reason,
                };
            }

            return {
                completed: true,
                reason: verifyResponseAll.reason,
            };
        }

        return {
            completed: true,
            reason: verifyResponse.reason,
        };
    }

    return {
        completed: true,
    };
}

async function domExtractHelper({
    browser,
    context,
    tabId,
    instructions,
    schema,
    content = {},
    chunksSeen = [],
    jarvis,
    runId,
    nodeId,
    threadId,
}) {
    try {
        const isRunActive = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive) {
            return {
                success: false,
                message: "Run is not active.",
            };
        }

        const { tabs, tabsString } = await getBrowserTabsAndMetaInformation({
            context,
        });

        const tab = tabs.find((tab) => tab.tabId === tabId);
        if (!tab) {
            throw new Error(
                `Tab with ID ${tabId} not found. Current tabs: ${tabsString}`
            );
        }

        const page = await context.pages()[tab.index];

        const chunkNumber = chunksSeen.length;
        await scrollToChunk(page, chunkNumber);

        // take a screenshot
        const { success, imageUrl, privateImageUrl } = await screenshotHelper({
            page,
            runId,
            nodeId,
            jarvis,
            threadId,
        });

        await waitForSettledDom(page);
        await debugDom(page);

        const { outputString, selectorMap, chunk, chunks } = await processDom({
            page,
            chunksSeen,
        });

        await cleanupDebug(page);

        const isRunActive2 = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive2) {
            return {
                success: false,
                message: "Run is not active.",
            };
        }

        const { completed, extractedContent, summaryOfExtractedContent } =
            await extractLLMHelper({
                instructions,
                schema,
                previouslyExtractedContent: content,
                domElements: outputString,
                chunksSeen: chunksSeen.length,
                chunksTotal: chunks.length,
                jarvis,
                runId,
                nodeId,
                threadId,
                imageUrl,
                privateImageUrl,
            });

        chunksSeen.push(chunk);

        const isRunActive3 = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive3) {
            return {
                success: false,
                message: "Run is not active.",
            };
        }

        if (completed || chunksSeen.length === chunks.length) {
            return {
                success: !!completed,
                message: completed
                    ? `DOM extracted successfully`
                    : `DOM extraction failed`,
                extractedContent,
                summaryOfExtractedContent,
            };
        } else {
            await waitForSettledDom(page);

            return domExtractHelper({
                browser,
                context,
                tabId,
                instructions,
                schema,
                content: extractedContent,
                chunksSeen,
                jarvis,
                runId,
                nodeId,
                threadId,
            });
        }
    } catch (err) {
        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Error extracting text from tab ${tabId}.`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: err.message,
                                    name: "Error",
                                },
                            ],
                        },
                    ],
                },
            ],
        });
        console.log(err);
        return {
            success: false,
            message: `Error extracting text from tab ${tabId}: ${err.message}`,
        };
    }
}

async function textExtractHelper({
    jarvis,
    browser,
    context,
    tabId,
    runId,
    nodeId,
    threadId,
    instructions,
    schema,
    content = {},
    chunksSeen = [],
}) {
    try {
        const isRunActive = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive) {
            return {
                success: false,
                message: "Run is not active.",
            };
        }

        const { tabs, tabsString } = await getBrowserTabsAndMetaInformation({
            context,
        });

        const tab = tabs.find((tab) => tab.tabId === tabId);
        if (!tab) {
            throw new Error(
                `Tab with ID ${tabId} not found. Current tabs: ${tabsString}`
            );
        }

        const chunkNumber = chunksSeen.length;

        const page = await context.pages()[tab.index];
        await scrollToChunk(page, chunkNumber);

        // take a screenshot
        const { success, imageUrl, privateImageUrl } = await screenshotHelper({
            page,
            runId,
            nodeId,
            jarvis,
            threadId,
        });

        const isRunActive2 = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive2) {
            return {
                success: false,
                message: "Run is not active.",
            };
        }

        await waitForSettledDom(page);
        await debugDom(page);

        const originalDom = await getOriginalDOM(page);

        const { outputString, selectorMap, chunk, chunks } = await processDom({
            page,
            chunksSeen,
        });

        // const { selectorMap } = await processAllOfDom(page);

        await createTextBoundingBoxes(page);
        const pageWidth = await page.evaluate(() => window.innerWidth);
        const pageHeight = await page.evaluate(() => window.innerHeight);

        const allAnnotations = [];

        let xpathList = [];

        for (const xpaths of Object.values(selectorMap)) {
            const xpath = xpaths[0];
            xpathList.push(xpath);
        }

        const boundingBoxesMap = await getElementBoundingBoxesMaster(
            page,
            xpathList
        );

        for (const xpaths of Object.values(selectorMap)) {
            const xpath = xpaths[0];

            // boundingBoxes is an array because there may be multiple bounding boxes within a single element
            // (since each bounding box is around a single word)
            const boundingBoxes = boundingBoxesMap[xpath];

            if (!boundingBoxes) {
                continue;
            }

            for (const box of boundingBoxes) {
                const bottom_left = {
                    x: box.left,
                    y: box.top + box.height,
                };
                const bottom_left_normalized = {
                    x: box.left / pageWidth,
                    y: (box.top + box.height) / pageHeight,
                };

                const annotation = {
                    text: box.text,
                    bottom_left,
                    bottom_left_normalized,
                    width: box.width,
                    height: box.height,
                };
                if (annotation.text.length > 0) {
                    allAnnotations.push(annotation);
                }
            }
        }

        const annotationsGroupedByText = {};

        for (const annotation of allAnnotations) {
            if (!annotationsGroupedByText[annotation.text]) {
                annotationsGroupedByText[annotation.text] = [];
            }
            annotationsGroupedByText[annotation.text].push(annotation);
        }

        const deduplicatedTextAnnotations = [];

        // Deduplicate annotations per text group
        for (const text in annotationsGroupedByText) {
            const annotations = annotationsGroupedByText[text];

            for (const annotation of annotations) {
                // Check if this annotation is close to any existing deduplicated annotation
                const isDuplicate = deduplicatedTextAnnotations.some(
                    (existingAnnotation) => {
                        if (existingAnnotation.text !== text) return false;

                        const dx =
                            existingAnnotation.bottom_left.x -
                            annotation.bottom_left.x;
                        const dy =
                            existingAnnotation.bottom_left.y -
                            annotation.bottom_left.y;
                        const distance = Math.hypot(dx, dy);

                        const PROXIMITY_THRESHOLD = 15;
                        return distance < PROXIMITY_THRESHOLD;
                    }
                );

                if (!isDuplicate) {
                    deduplicatedTextAnnotations.push(annotation);
                }
            }
        }

        const isRunActive3 = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive3) {
            return {
                success: false,
                message: "Run is not active.",
            };
        }

        await restoreDOM(page, originalDom);

        const formattedText = formatText(
            deduplicatedTextAnnotations,
            pageWidth
        );

        const { completed, extractedContent, summaryOfExtractedContent } =
            await extractLLMHelper({
                instructions,
                schema,
                previouslyExtractedContent: content,
                domElements: formattedText,
                chunksSeen: chunksSeen.length,
                chunksTotal: chunks.length,
                jarvis,
                runId,
                nodeId,
                threadId,
                imageUrl,
                privateImageUrl,
            });

        await cleanupDebug(page);

        chunksSeen.push(chunk);

        const isRunActive4 = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive4) {
            return {
                success: false,
                message: "Run is not active.",
            };
        }

        if (completed || chunksSeen.length === chunks.length) {
            return {
                success: !!completed,
                message: completed
                    ? `Text extracted successfully`
                    : `Text extraction failed`,
                extractedContent,
                summaryOfExtractedContent,
            };
        } else {
            await waitForSettledDom(page);

            return textExtractHelper({
                browser,
                context,
                tabId,
                instructions,
                schema,
                content: extractedContent,
                chunksSeen,
                jarvis,
                runId,
                nodeId,
                threadId,
            });
        }
    } catch (err) {
        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Error extracting text from tab ${tabId}.`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: err.message,
                                    name: "Error",
                                },
                            ],
                        },
                    ],
                },
            ],
        });
        console.log(err);
        return {
            success: false,
            message: `Error extracting text from tab ${tabId}: ${err.message}`,
        };
    }
}

async function extractHelper({
    browser,
    context,
    tabId,
    instructions,
    schema,
    useTextExtract,
    jarvis,
    runId,
    nodeId,
    threadId,
}) {
    if (useTextExtract) {
        return textExtractHelper({
            browser,
            context,
            tabId,
            instructions,
            schema,
            jarvis,
            runId,
            nodeId,
            threadId,
        });
    }

    return await domExtractHelper({
        browser,
        context,
        tabId,
        instructions,
        schema,
        jarvis,
        runId,
        nodeId,
        threadId,
    });
}

async function resizeImage({ image, width, height }) {
    try {
        // Create sharp instance from buffer
        const sharpImage = sharp(image);

        // Get image metadata
        const metadata = await sharpImage.metadata();
        const aspectRatio = metadata.width / metadata.height;

        // Calculate new dimensions maintaining aspect ratio
        let newWidth = width;
        let newHeight = height;

        if (width / height > aspectRatio) {
            // Image is relatively taller
            newWidth = Math.round(height * aspectRatio);
        } else {
            // Image is relatively wider
            newHeight = Math.round(width / aspectRatio);
        }

        // Resize image
        const resizedImage = await sharpImage
            .resize(newWidth, newHeight, {
                fit: "contain",
                background: { r: 255, g: 255, b: 255, alpha: 1 },
            })
            .jpeg({ quality: 100 })
            .toBuffer();

        return resizedImage;
    } catch (error) {
        console.error("Error resizing image:", error);
        throw error;
    }
}

// Helper function to get total number of chunks
async function getTotalChunks(page) {
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const totalHeight = await page.evaluate(() => document.body.scrollHeight);
    return Math.ceil(totalHeight / viewportHeight);
}

async function screenshotHelper({
    page,
    runId,
    nodeId,
    jarvis,
    threadId,
    scaleDown,
}) {
    try {
        const isRunActive = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive) {
            return {
                success: false,
                imageUrl: "",
                privateImageUrl: "",
            };
        }

        await waitForSettledDom(page);

        // Set viewport size
        await page.setViewportSize({
            width: Number(process.env.BROWSER_WIDTH),
            height: Number(process.env.BROWSER_HEIGHT),
        });

        // Take screenshot
        let screenshot = await page.screenshot({
            type: "jpeg",
            quality: 90,
            timeout: 90000,
        });

        if (scaleDown) {
            screenshot = await resizeImage({
                image: screenshot,
                width: scaleDown.width,
                height: scaleDown.height,
            });
        }

        // Upload to S3
        const uploadResult = await uploadFileToS3({
            name: `${Date.now()}.jpeg`,
            file: screenshot,
            folder: `runs/${runId}/screenshots/${nodeId}`,
            contentType: "image/jpeg",
        });

        if (!uploadResult) {
            throw new Error("Failed to upload screenshot");
        }

        return {
            imageUrl: uploadResult.publicUrl,
            privateImageUrl: uploadResult.privateUrl,
            success: true,
        };
    } catch (err) {
        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Error taking screenshot.`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: err.message,
                                    name: "Error",
                                },
                            ],
                        },
                    ],
                },
            ],
        });
        return {
            success: false,
            message: `Error taking screenshot: ${err.message}`,
        };
    }
}

async function simpleActionHelper({
    browser,
    context,
    action,
    expectationFromAction,
    jarvis,
    runId,
    nodeId,
    threadId,
    tabId,
    mainTask,
}) {
    let plannerAttempts = 0;
    const MAX_PLANNER_ATTEMPTS = 10;
    const STEPS_BEFORE_REPLANNING = 5;
    let steps = [];
    let stepsPerformedSinceLastPlan = 0;
    let currentHighLevelSteps = [];
    let currentGoal = null;
    let challenges = [];

    const { tabs, tabsString } = await getBrowserTabsAndMetaInformation({
        context,
    });
    const tab = tabs.find((tab) => tab.tabId === tabId);
    if (!tab) {
        return {
            success: false,
            message: `Tab with ID ${tabId} not found.`,
        };
    }
    const page = await context.pages()[tab.index];

    async function runPlanner({
        screenshot,
        currentChunk,
        totalChunks,
        currentChunkDom,
    }) {
        plannerAttempts++;
        if (plannerAttempts > MAX_PLANNER_ATTEMPTS) {
            return {
                type: "error",
                highLevelSteps: [],
                stateAnalysis: "Max planner attempts exceeded",
                progressPercentage: 100,
                challenges: [],
                explanation: "Max planner attempts exceeded",
            };
        }

        /*
        Current chunk: ${currentChunk + 1}
        Total chunks: ${totalChunks}

        - nextChunk: number or null. The next chunk to read. If you decide, you need to see more of the page to make a decision, set this to the relevant chunk number.

        nextChunk usage:
If you decide to read the next/prev chunk, then you can skip challenges and highLevelSteps.
If you think the action is complete, then you can set progressPercentage to 100, highLevelSteps to an empty array, and nextChunk to null.
If you think the action is not possible at all, then you can set progressPercentage to 0, highLevelSteps to an array with ["error"], and explanation to the reason why.

                        "nextChunk (number or null), " +
        */

        const plannerResponse = await callOpenAICompatibleLLMWithRetry({
            messages: [
                {
                    role: "system",
                    content:
                        "You are a planner analyzing the current state of a webpage and determining the next steps. " +
                        "Respond with a JSON object containing: " +
                        "stateAnalysis (string), " +
                        "progressPercentage (number), " +
                        "challenges (array of strings), " +
                        "highLevelSteps (array of strings), " +
                        "and explanation (string).",
                },
                {
                    role: "user",
                    content: `
Main parent task: ${mainTask}
Your task to complete: ${action}
Expected outcome: ${expectationFromAction}
Current chunk DOM: ${currentChunkDom}
Steps performed so far: ${JSON.stringify(steps)}

Return a JSON object with the following fields:
- stateAnalysis: string. A description of the current state of the webpage.
- progressPercentage: number. The percentage of the action that has been completed. (0-100)
- challenges: array of strings. The challenges and roadblocks you anticipate in completing the action.
- highLevelSteps: array of strings. The high-level steps to perform next. max 3-4 steps are ideal. 
- explanation: string. An explanation of the current state and the next steps.


progressPercentage usage:
- If you think the action is complete, then you can set progressPercentage to 100, highLevelSteps to an empty array
- If you think the action is not possible at all, then you can set progressPercentage to 0, highLevelSteps to an array with ["error"], and explanation to the reason why.

explanation usage:
- Fill this always to explain your reasoning.

stateAnalysis usage:
- Fill this always to explain the current state of the webpage.
`,
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: {
                                url: screenshot,
                            },
                        },
                    ],
                },
            ],
            models: [
                "gemini-2.5-flash",
                "deepseek-chat",
                "claude-3-5-sonnet",
                "gpt-4o",
                "qwen-plus",
            ],
            metadata: {
                runId,
                nodeId,
                agentCode: this.CODE,
                usecase: "action_planner",
                flowId: jarvis.flow_id,
                accountId: jarvis.account_id,
                threadId,
            },
            max_attempts: 3,
        });

        // If planner wants to change chunks, that's the only action we return
        // if (
        //     plannerResponse.nextChunk !== null &&
        //     plannerResponse.nextChunk !== currentChunk + 1
        // ) {
        //     return {
        //         type: "chunk_change",
        //         targetChunk: plannerResponse.nextChunk,
        //     };
        // }

        if (plannerResponse.progressPercentage === 100) {
            return {
                type: "end",
                highLevelSteps: [],
                stateAnalysis: "Action completed successfully",
                progressPercentage: 100,
                explanation: plannerResponse.explanation,
            };
        }

        if (
            plannerResponse.progressPercentage === 0 &&
            plannerResponse.highLevelSteps.length === 1 &&
            plannerResponse.highLevelSteps[0] === "error"
        ) {
            return {
                type: "error",
                explanation: plannerResponse.explanation,
            };
        }

        return {
            type: "continue",
            highLevelSteps: plannerResponse.highLevelSteps,
            stateAnalysis: plannerResponse.stateAnalysis,
            progressPercentage: plannerResponse.progressPercentage,
            challenges: plannerResponse.challenges,
            explanation: plannerResponse.explanation,
        };
    }

    async function runner({
        highLevelSteps,
        challenges,
        screenshot,
        currentChunk,
        totalChunks,
        currentChunkDom,
        previousGoal = null,
        mainTask,
    }) {
        /*
                                nextChunk (number or null), 


                                Current chunk: ${currentChunk + 1}/${totalChunks}
Previous goal: ${previousGoal || "none"}

- nextChunk: number or null. The next chunk to read. If you decide, you need to see more of the page to make a decision, set this to the relevant chunk number.

WHEN TO USE THE NEXT CHUNK:
- If you think you need to scroll the page up or down to perform more actions. Then set nextChunk to the next chunk to read.
- If you are happy with where the page is currently at, then don't set nextChunk. there is no need to unnecessarily read more of the page.
- DO NOT CHANGE CHUNK UNLESS YOU ARE SURE THAT YOU NEED TO. ALMOST ALWAYS YOU WILL NOT NEED TO CHANGE CHUNK.

        */
        const runnerResponse = await callOpenAICompatibleLLMWithRetry({
            messages: [
                {
                    role: "system",
                    content: `
                        You are a runner that analyzes the current state of a webpage, the previous goal, previous work so far, the high-level steps and decides what to do next. 
                        Respond with a JSON object containing: 
                        previousGoalAnalysis (string),
                        goal (string or null), 
                        playwrightMethod (string or null), 
                        playwrightArgs (array or null),
                        playwrightElement (number or null).

                        previousGoalAnalysis: string. A description of the analysis of the previous goal. If the previous goal is achieved or not and why. 

                        If you think the action is complete, then you can set goal to "end", playwrightMethod to null, and playwrightArgs to null.
                        If you think the action is not possible at all, then you can set goal to "error", playwrightMethod to null, and playwrightArgs to null.
                        `,
                },
                {
                    role: "user",
                    content: `
Main task: ${mainTask}
High level sub steps relavant to you: ${highLevelSteps.join("\n")}
Challenges and roadblocks: ${challenges.join("\n")}
Current chunk DOM: ${currentChunkDom}
Previous work so far: ${JSON.stringify(steps)}

RETURN A JSON OBJECT WITH THE FOLLOWING FIELDS:
- thinking: Explain your thought process in a detailed manner.
- previousGoalAnalysis: string. A description of the analysis of the previous goal. If the previous goal is achieved or not and why. 
- goal: string or null. The next goal to achieve.
- playwrightMethod: string or null. The playwright method to use.
- playwrightArgs: Arguments to pass to the playwright method. Array.
- playwrightElement: number or null. The element number to act on.


goal usage:
- If you think the action is complete, then you can set goal to "end".
- If you think the action is not possible at all, then you can set goal to "error".
- In all other cases, set goal to the next goal to achieve.

previousGoalAnalysis usage:
- Fill this always to explain the analysis of the previous goal.
                    `,
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: {
                                url: screenshot,
                            },
                        },
                    ],
                },
            ],
            models: [
                "gemini-2.5-flash",
                "deepseek-chat",
                "claude-3-5-sonnet",
                "gpt-4o",
                "qwen-plus",
            ],
            metadata: {
                runId,
                nodeId,
                agentCode: this.CODE,
                usecase: "action_runner",
                flowId: jarvis.flow_id,
                accountId: jarvis.account_id,
                threadId,
            },
            max_attempts: 3,
        });

        // If runner wants to change chunks, that's the only action we return
        // if (
        //     runnerResponse.nextChunk !== null &&
        //     runnerResponse.nextChunk !== currentChunk + 1
        // ) {
        //     return {
        //         type: "chunk_change",
        //         targetChunk: runnerResponse.nextChunk,
        //         goal: "Change viewport",
        //     };
        // }

        if (runnerResponse.goal === "end") {
            return {
                type: "end",
                goal: "End",
            };
        }

        if (runnerResponse.goal === "error") {
            return {
                type: "error",
            };
        }

        if (
            !runnerResponse.playwrightMethod &&
            !runnerResponse.playwrightArgs &&
            !runnerResponse.playwrightElement
        ) {
            // consider this as done
            return {
                type: "end",
                goal: "End",
            };
        }

        return {
            type: "action",
            goal: runnerResponse.goal,
            method: runnerResponse.playwrightMethod,
            args: runnerResponse.playwrightArgs,
            element: runnerResponse.playwrightElement,
            previousGoalAnalysis: runnerResponse.previousGoalAnalysis,
        };
    }

    async function performStep({
        method,
        args,
        goal,
        element,
        selectorMap,
        outputString,
        currentChunk,
        totalChunks,
    }) {
        const initialUrl = page.url();
        const xpaths = selectorMap[element];
        // Get the element text from the outputString
        const elementLines = outputString.split("\n");
        const elementText =
            elementLines
                .find((line) => line.startsWith(`${element}:`))
                ?.split(":")[1] || "";

        let foundXpath = null;
        let locator = null;

        for (const xp of xpaths) {
            const candidate = page.locator(`xpath=${xp}`).first();
            try {
                // Try a short wait to see if it's attached to the DOM
                await candidate.waitFor({
                    state: "attached",
                    timeout: 2000,
                });
                foundXpath = xp;
                locator = candidate;
                break;
            } catch (e) {
                console.log(e);
            }
        }

        // If no XPath was valid, we cannot proceed
        if (!foundXpath || !locator) {
            // not possible to perform the action.
            return {
                success: false,
                message: "None of the provided XPaths could be located.",
            };
        }

        await _performPlaywrightMethod({
            method,
            args,
            xpath: foundXpath,
            page,
            context,
        });

        await waitForSettledDom(page);
        const newUrl = page.url();

        return {
            urlChanged: newUrl !== initialUrl,
            oldUrl: initialUrl,
            newUrl: newUrl,
            success: true,
        };
    }

    try {
        await waitForSettledDom(page);

        // Main action loop
        while (true) {
            const chunksInfo = await getChunksInfo(page);
            const { outputString, selectorMap } = await processCurrentChunk(
                page
            );
            const { currentChunk, totalChunks } = chunksInfo;

            const { success, imageUrl, privateImageUrl } =
                await screenshotHelper({
                    page,
                    runId,
                    nodeId,
                    jarvis,
                    threadId,
                });

            // Call planner if needed
            if (
                currentHighLevelSteps.length === 0 ||
                stepsPerformedSinceLastPlan >= STEPS_BEFORE_REPLANNING
            ) {
                await jarvis.updateNodeUserLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: "Planning next step.",
                                },
                            ],
                        },
                    ],
                });

                const plannerResult = await runPlanner({
                    currentChunk,
                    totalChunks,
                    screenshot: privateImageUrl,
                    currentChunkDom: outputString,
                });

                await jarvis.updateNodeUserLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text:
                                        "Planner result. Progress percentage: " +
                                        plannerResult.progressPercentage,
                                    associatedData: [
                                        {
                                            type: "code",
                                            code: plannerResult,
                                            name: "Planner result",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                });

                await jarvis.updateNodeDebugLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: `${
                                        plannerResult.explanation
                                            ? `Planner: ${plannerResult.explanation}`
                                            : "Planner result"
                                    }`,
                                    associatedData: [
                                        {
                                            type: "code",
                                            code: plannerResult,
                                            name: "Planner result",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                });

                // if (plannerResult.type === "chunk_change") {
                //     // Handle chunk change
                //     await scrollToChunk(page, plannerResult.targetChunk);
                //     await waitForSettledDom(page);

                //     continue;
                // } else
                if (plannerResult.type === "end") {
                    return {
                        success: true,
                        message: `Action completed successfully. ${plannerResult.explanation}`,
                        steps,
                    };
                } else if (plannerResult.type === "error") {
                    return {
                        success: false,
                        message: `Action failed. ${plannerResult.explanation}`,
                        steps,
                    };
                }

                stepsPerformedSinceLastPlan = 0;
                currentHighLevelSteps = plannerResult.highLevelSteps;
            } else {
                await jarvis.updateNodeUserLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: "Deciding how to perform the high level steps.",
                                    associatedData: [
                                        {
                                            type: "code",
                                            code: {
                                                currentHighLevelSteps,
                                                challenges,
                                            },
                                            name: "Steps to perform",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                });

                // we call runner with the highLevelSteps, challenges, explanation, currentChunk, totalChunks, currentChunkDom, previousGoal
                const runnerResult = await runner({
                    highLevelSteps: currentHighLevelSteps,
                    challenges,
                    currentChunk,
                    totalChunks,
                    screenshot: privateImageUrl,
                    currentChunkDom: outputString,
                    previousGoal: currentGoal,
                });

                currentGoal = runnerResult.goal;

                const {
                    goal,
                    method,
                    args,
                    element,
                    previousGoalAnalysis,
                    type,
                    targetChunk,
                } = runnerResult;

                await jarvis.updateNodeUserLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: `${
                                        runnerResult.type === "chunk_change"
                                            ? "Decided to change chunk"
                                            : runnerResult.type === "end"
                                            ? "Runner completed the action"
                                            : runnerResult.type === "error"
                                            ? "Runner failed to complete the action"
                                            : "Decided on next sub-goal and how to perform it."
                                    }`,
                                    associatedData: [
                                        {
                                            type: "code",
                                            code: runnerResult,
                                            name: "Goal",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                });

                await jarvis.updateNodeDebugLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: `${
                                        runnerResult.type === "chunk_change"
                                            ? "Decided to change chunk"
                                            : runnerResult.type === "end"
                                            ? "Runner completed the action"
                                            : runnerResult.type === "error"
                                            ? "Runner failed to complete the action"
                                            : "Decided on next sub-goal and how to perform it."
                                    }`,
                                    associatedData: [
                                        {
                                            type: "code",
                                            code: runnerResult,
                                            name: "Goal",
                                        },
                                        {
                                            type: "markdown",
                                            markdown: previousGoalAnalysis,
                                            name: "Previous goal analysis",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                });

                // if (type === "chunk_change") {
                //     // Handle chunk change
                //     await scrollToChunk(page, targetChunk);
                //     await waitForSettledDom(page);
                //     currentGoal = null;
                //     currentHighLevelSteps = [];
                //     continue;
                // } else
                if (runnerResult.type === "end") {
                    currentGoal = null;
                    currentHighLevelSteps = [];
                    continue;
                } else if (runnerResult.type === "error") {
                    currentGoal = null;
                    currentHighLevelSteps = [];
                    continue;
                } else if (type === "action") {
                    // Perform the step
                    stepsPerformedSinceLastPlan++;

                    await jarvis.updateNodeUserLog({
                        runId,
                        nodeId,
                        threadId,
                        messages: [
                            {
                                role: "assistant",
                                content: [
                                    {
                                        type: "text",
                                        text: `Performing step. Goal: ${goal} Method: ${method}. Element: ${element}.`,
                                    },
                                ],
                            },
                        ],
                    });

                    await jarvis.updateNodeDebugLog({
                        runId,
                        nodeId,
                        threadId,
                        messages: [
                            {
                                role: "assistant",
                                content: [
                                    {
                                        type: "text",
                                        text: `Performing step. Goal: ${goal} Method: ${method}. Element: ${element}.`,
                                        associatedData: [
                                            {
                                                type: "code",
                                                code: {
                                                    goal,
                                                    method,
                                                    element,
                                                    selectorMap,
                                                    outputString,
                                                },
                                                name: "Goal",
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    });

                    // if method, goal, element, args are not null, then perform the step
                    if (method && goal && element && args) {
                        // Perform the step
                        const stepResult = await performStep({
                            method,
                            args,
                            goal,
                            element,
                            selectorMap,
                            outputString,
                        });

                        await jarvis.updateNodeUserLog({
                            runId,
                            nodeId,
                            threadId,
                            messages: [
                                {
                                    role: "assistant",
                                    content: [
                                        {
                                            type: "text",
                                            text: `Performed: ${goal} ${
                                                stepResult.message || ""
                                            }`,
                                        },
                                    ],
                                },
                            ],
                        });

                        await jarvis.updateNodeDebugLog({
                            runId,
                            nodeId,
                            threadId,
                            messages: [
                                {
                                    role: "assistant",
                                    content: [
                                        {
                                            type: "text",
                                            text: `Performed: ${goal} ${
                                                stepResult.message || ""
                                            }`,
                                        },
                                    ],
                                },
                            ],
                        });

                        const { success, message, urlChanged, oldUrl, newUrl } =
                            stepResult;

                        steps.push(
                            `Action ${method} to achieve ${goal} is performed. ${
                                message || ""
                            }`
                        );

                        if (urlChanged) {
                            steps.push(
                                `URL changed from ${oldUrl} to ${newUrl}`
                            );
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error(error);
        return {
            success: false,
            message: `Action failed: ${error.message}`,
            steps,
        };
    }
}

// Works well with CUA type models
async function actHelperWithVision({
    browser,
    context,
    action,
    expectationFromAction,
    jarvis,
    runId,
    nodeId,
    threadId,
    steps = [],
    attempt = 0,
}) {
    try {
        const { tabs, tabsString } = await getBrowserTabsAndMetaInformation({
            context,
        });

        // let width = 1279;
        // let height = 632;
        let width = 1092;
        let height = 1092;
        let lastStepImageUrl = null;
        // if steps is not empty, check if the last step has an image_url
        if (steps.length > 0 && steps[steps.length - 1].image_url) {
            // if it does, add the image_url to the steps
            lastStepImageUrl = steps[steps.length - 1].image_url;

            // get the width and height of the image. use axios
            const image = await axiosInstance.get(lastStepImageUrl, {
                responseType: "arraybuffer",
            });
            const metadata = await sharp(image.data).metadata();
            width = metadata.width;
            height = metadata.height;
        }

        let step = {};

        const messages = browserablePrompts.buildVisionActionPrompt({
            action,
            expectationFromAction,
            width,
            height,
            steps,
            tabsString,
            lastStepImageUrl,
        });

        const response = await callOpenAICompatibleLLMWithRetry({
            messages,
            runId,
            models: [
                "gemini-2.5-flash",
                "deepseek-chat",
                "claude-3-5-sonnet",
                "gpt-4o",
                "qwen-plus",
            ],
            metadata: {
                runId,
                nodeId,
                agentCode: this.CODE,
                usecase: "vision_action",
                flowId: jarvis.flow_id,
                accountId: jarvis.account_id,
                threadId,
            },
            max_attempts: 3,
        });

        const { function_name, arguments, reason, learningFromImage } =
            response;

        if (function_name === "exit") {
            return {
                success: arguments.completed,
                message: `Action ${
                    arguments.completed ? "completed" : "failed"
                }: ${reason}. Read the tab to confirm if the task is completed visually and to decide how to proceed.`,
            };
        }

        let textResult = "";
        let imageResult = null;
        let privateImageResult = null;
        let scaleXAmount = Number(process.env.BROWSER_WIDTH) / width;
        let scaleYAmount = Number(process.env.BROWSER_HEIGHT) / height;

        await jarvis.updateNodeUserLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Performing action: ${function_name}.`,
                        },
                    ],
                },
            ],
        });

        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Performing action: ${function_name}.`,
                            associatedData: [
                                {
                                    type: "code",
                                    code: response,
                                    name: "Response",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        // perform the action.
        if (function_name === "click") {
            const { tabId, x, y } = arguments;

            const tab = tabs.find((tab) => tab.tabId === tabId);
            if (!tab) {
                textResult = `Tab with ID ${tabId} not found.`;
            }

            if (tab) {
                const page = await context.pages()[tab.index];
                await clickOnPage({
                    page,
                    runId,
                    nodeId,
                    x: x * scaleXAmount,
                    y: y * scaleYAmount,
                });
                // wait for dom to settle
                await waitForSettledDom(page);
                textResult = `Tried clicking on x: ${x}, y: ${y}. Confirm if required with a screenshot.`;
            }
        }

        if (function_name === "type") {
            const { tabId, text, x, y } = arguments;

            const tab = tabs.find((tab) => tab.tabId === tabId);
            if (!tab) {
                textResult = `Tab with ID ${tabId} not found.`;
            }

            if (tab) {
                const page = await context.pages()[tab.index];
                await typeOnPage({
                    page,
                    runId,
                    nodeId,
                    text,
                    x: x * scaleXAmount,
                    y: y * scaleYAmount,
                });
                // wait for dom to settle
                await waitForSettledDom(page);
                textResult = `Tried typing text: ${text}. Confirm if required with a screenshot.`;
            }
        }

        if (function_name === "keyPress") {
            const { tabId, key, x, y } = arguments;

            const tab = tabs.find((tab) => tab.tabId === tabId);
            if (!tab) {
                textResult = `Tab with ID ${tabId} not found.`;
            }

            if (tab) {
                const page = await context.pages()[tab.index];
                await keyOnPage({
                    page,
                    runId,
                    nodeId,
                    key,
                    x: x * scaleXAmount,
                    y: y * scaleYAmount,
                });
                // wait for dom to settle
                await waitForSettledDom(page);
                textResult = `Tried pressing key: ${key}. Confirm if required with a screenshot.`;
            }
        }

        if (function_name === "scroll") {
            const { tabId, x, y, deltaX, deltaY } = arguments;

            const tab = tabs.find((tab) => tab.tabId === tabId);
            if (!tab) {
                textResult = `Tab with ID ${tabId} not found.`;
            }

            if (tab) {
                const page = await context.pages()[tab.index];
                await scrollOnPage({
                    page,
                    runId,
                    nodeId,
                    x: x * scaleXAmount,
                    y: y * scaleYAmount,
                    deltaX: (deltaX || 0) * scaleXAmount,
                    deltaY: (deltaY || 0) * scaleYAmount,
                });
                // wait for dom to settle
                await waitForSettledDom(page);
                textResult = `Tried scrolling at x: ${x}, y: ${y} with deltaX: ${deltaX}, deltaY: ${deltaY}. Confirm if required with a screenshot.`;
            }
        }

        if (function_name === "double_click") {
            const { tabId, x, y } = arguments;

            const tab = tabs.find((tab) => tab.tabId === tabId);
            if (!tab) {
                textResult = `Tab with ID ${tabId} not found.`;
            }

            if (tab) {
                const page = await context.pages()[tab.index];
                await clickOnPage({
                    page,
                    runId,
                    nodeId,
                    x: x * scaleXAmount,
                    y: y * scaleYAmount,
                    doubleClick: true,
                });
                // wait for dom to settle
                await waitForSettledDom(page);
                textResult = `Tried double clicking on x: ${x}, y: ${y}. Confirm if required with a screenshot.`;
            }
        }

        if (function_name === "screenshot") {
            const { tabId } = arguments;

            const tab = tabs.find((tab) => tab.tabId === tabId);
            if (!tab) {
                textResult = `Tab with ID ${tabId} not found.`;
            }

            if (tab) {
                const page = await context.pages()[tab.index];

                const { success, imageUrl, privateImageUrl } =
                    await screenshotHelper({
                        page,
                        runId,
                        nodeId,
                        jarvis,
                        scaleDown: {
                            width,
                            height,
                        },
                    });

                if (success) {
                    imageResult = imageUrl;
                    privateImageResult = privateImageUrl;
                    textResult = `Screenshot taken of tab ${tabId}.`;
                }
            }
        }

        step = {
            actionDescription: `${
                learningFromImage
                    ? `Learning from the last step image: ${learningFromImage}\n`
                    : ""
            } Decided to perform action: ${function_name}`,
            result: textResult,
            image_url: privateImageResult,
        };

        // call this function again with the new step
        return await actHelperWithVision({
            browser,
            context,
            action,
            expectationFromAction,
            jarvis,
            runId,
            nodeId,
            threadId,
            steps: [...steps, step],
            attempt,
        });
    } catch (err) {
        console.log(err);

        return {
            success: false,
            message: `Error performing action: ${err.message}`,
        };
    }
}

async function actHelper({
    browser,
    context,
    tabId,
    action,
    expectationFromAction,
    jarvis,
    runId,
    nodeId,
    threadId,
    // previousSelectors = [],
    steps = "",
    chunksSeen = [],
    variables = {},
}) {
    try {
        const isRunActive = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive) {
            return {
                success: false,
                message: "Run is not active.",
            };
        }

        const { tabs, tabsString } = await getBrowserTabsAndMetaInformation({
            context,
        });

        const tab = tabs.find((tab) => tab.tabId === tabId);
        if (!tab) {
            throw new Error(
                `Tab with ID ${tabId} not found. Current tabs: ${tabsString}`
            );
        }

        const page = await context.pages()[tab.index];

        const { success, imageUrl, privateImageUrl } = await screenshotHelper({
            page,
            runId,
            nodeId,
            jarvis,
            threadId,
        });

        const isRunActive2 = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive2) {
            return {
                success: false,
                message: "Run is not active.",
                imageUrl: "",
                privateImageUrl: "",
            };
        }

        // Wait for the page to fully load before executing JavaScript
        // await page.waitForLoadState("networkidle");

        await jarvis.updateNodeUserLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Performing action: ${action}.`,
                            associatedData: [
                                {
                                    type: "image",
                                    url: imageUrl,
                                    name: "Screenshot",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Performing action: ${action}.`,
                            associatedData: [
                                {
                                    type: "image",
                                    url: imageUrl,
                                    name: "Screenshot",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        await waitForSettledDom(page);
        await debugDom(page);

        const { outputString, selectorMap, chunk, chunks } = await processDom({
            page,
            chunksSeen,
        });

        const isRunActive3 = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive3) {
            return {
                success: false,
                message: "Run is not active.",
                imageUrl: "",
                privateImageUrl: "",
            };
        }

        const response = await actLLMHelper({
            action,
            expectationFromAction,
            domElements: outputString,
            steps,
            variables,
            jarvis,
            runId,
            nodeId,
            threadId,
            imageUrl,
            privateImageUrl,
        });

        const isRunActive4 = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive4) {
            return {
                success: false,
                message: "Run is not active.",
                imageUrl: "",
                privateImageUrl: "",
            };
        }

        await cleanupDebug(page);

        const { function_name, arguments } = response;

        if (function_name === "doAction") {
            await jarvis.updateNodeDebugLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: `Code written to perform the action. ${
                                    arguments.completed
                                        ? "Expecting this step to complete the action."
                                        : "This is only a part of the action to achieve user's goal."
                                }`,
                                associatedData: [
                                    {
                                        type: "code",
                                        code: {
                                            function_name,
                                            arguments,
                                        },
                                        name: "Code",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });

            await jarvis.updateNodeUserLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: `Decided how to perform the action. ${
                                    arguments.completed
                                        ? "Expecting this step to complete the action."
                                        : "This is only a part of the action to achieve user's goal."
                                }`,
                            },
                        ],
                    },
                ],
            });
        }

        const isRunActive5 = await jarvis.isRunActive({
            runId,
            flowId: jarvis.flow_id,
        });

        if (!isRunActive5) {
            return {
                success: false,
                message: "Run is not active.",
                imageUrl: "",
                privateImageUrl: "",
            };
        }

        if (function_name === "skipSection") {
            if (arguments && arguments.completed) {
                steps +=
                    (!steps.endsWith("\n") ? "\n" : "") +
                    "## Step: Scrolled to another section\n" +
                    (arguments && arguments.reason
                        ? `Reason: ${arguments.reason}\n`
                        : "");

                const { completed: actionCompleted, reason: actionReason } =
                    await verifyActionCompletion({
                        completed: arguments.completed,
                        action,
                        steps,
                        page,
                        jarvis,
                        runId,
                        nodeId,
                        threadId,
                        expectationFromAction,
                    });

                if (!actionCompleted) {
                    if (chunksSeen.length + 1 < chunks.length) {
                        chunksSeen.push(chunk);

                        steps += `  Reason: ${actionReason}\n`;

                        return actHelper({
                            browser,
                            context,
                            tabId,
                            action,
                            jarvis,
                            runId,
                            nodeId,
                            steps,
                            chunksSeen,
                            variables,
                            expectationFromAction,
                            threadId,
                            // previousSelectors,
                        });
                    } else {
                        return {
                            success: false,
                            message: `Action was not able to be completed. ${actionReason}`,
                            action,
                        };
                    }
                } else {
                    return {
                        success: true,
                        message: `Action completed successfully: ${steps}${arguments.step}`,
                        action: action,
                    };
                }
            }

            if (chunksSeen.length + 1 < chunks.length) {
                chunksSeen.push(chunk);

                return actHelper({
                    browser,
                    context,
                    tabId,
                    action,
                    jarvis,
                    runId,
                    nodeId,
                    steps,
                    chunksSeen,
                    variables,
                    expectationFromAction,
                    threadId,
                    // previousSelectors,
                });
            } else {
                return {
                    success: false,
                    message: `Action was not able to be completed.`,
                    action,
                };
            }
        } else if (function_name === "doAction") {
            // Action found, proceed to execute
            const elementId = arguments["element"];

            const xpaths = selectorMap[elementId];
            const method = arguments["method"];
            const args = arguments["args"];
            // Get the element text from the outputString
            const elementLines = outputString.split("\n");
            const elementText =
                elementLines
                    .find((line) => line.startsWith(`${elementId}:`))
                    ?.split(":")[1] || "";

            try {
                const initialUrl = page.url();
                const initialTabId = await getTabIdOfPage(page);

                let foundXpath = null;
                let locator = null;

                for (const xp of xpaths) {
                    const candidate = page.locator(`xpath=${xp}`).first();
                    try {
                        // Try a short wait to see if it's attached to the DOM
                        await candidate.waitFor({
                            state: "attached",
                            timeout: 2000,
                        });
                        foundXpath = xp;
                        locator = candidate;
                        break;
                    } catch (e) {
                        console.log(e);
                    }
                }

                // If no XPath was valid, we cannot proceed
                if (!foundXpath || !locator) {
                    throw new Error(
                        "None of the provided XPaths could be located."
                    );
                }

                const responseArgs = [...args];

                if (variables) {
                    responseArgs.forEach((arg, index) => {
                        if (typeof arg === "string") {
                            args[index] = fillInVariables(arg, variables);
                        }
                    });
                }

                await _performPlaywrightMethod({
                    page,
                    context,
                    method,
                    args,
                    xpath: foundXpath,
                });

                const newStepString =
                    (!steps.endsWith("\n") ? "\n" : "") +
                    `## Step: ${arguments.step}\n` +
                    (elementText ? `  Element: ${elementText}\n` : "") +
                    `  Action: ${arguments.method}\n` +
                    `  Reasoning: ${arguments.why}\n`;

                steps += newStepString;

                const newTabId = await getTabIdOfPage(page);

                if (page.url() !== initialUrl) {
                    steps += `  Result (Important): Page URL changed from ${initialUrl} to ${page.url()}\n\n`;
                }

                if (newTabId !== initialTabId) {
                    steps += `  Result (Important): Tab ID changed from ${initialTabId} to ${newTabId}\n\n`;
                }

                const isRunActive6 = await jarvis.isRunActive({
                    runId,
                    flowId: jarvis.flow_id,
                });

                if (!isRunActive6) {
                    return {
                        success: false,
                        message: "Run is not active.",
                        imageUrl: "",
                        privateImageUrl: "",
                    };
                }

                const { completed: actionCompleted } =
                    await verifyActionCompletion({
                        completed: arguments.completed,
                        action,
                        steps,
                        page,
                        jarvis,
                        runId,
                        nodeId,
                        expectationFromAction,
                        threadId,
                    });

                await jarvis.updateNodeUserLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: `Verified whether the action was completed. Result: ${
                                actionCompleted ? "Yes" : "No"
                            }.`,
                        },
                    ],
                });

                if (!actionCompleted) {
                    return actHelper({
                        browser,
                        context,
                        tabId: newTabId,
                        action,
                        jarvis,
                        runId,
                        nodeId,
                        threadId,
                        steps,
                        chunksSeen,
                        variables,
                        expectationFromAction,
                        // previousSelectors: [...previousSelectors, foundXpath],
                    });
                } else {
                    return {
                        success: true,
                        message: `Action completed successfully: ${steps}${arguments.step}`,
                        action: action,
                    };
                }
            } catch (error) {
                console.error("Error running an action", error);
                return {
                    success: false,
                    message: `Error performing action - C: ${error.message}`,
                    action: action,
                };
            }
        } else if (function_name === "actionCompleted") {
            return {
                success: true,
                message: `Action completed successfully: ${steps}${arguments.step}`,
                action: action,
            };
        }
    } catch (error) {
        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Error performing action.`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: error.message,
                                    name: "Error",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        console.log("error", error);
        return {
            success: false,
            message: `Error performing action - B: ${error.message}`,
            action: action,
        };
    }
}

async function _performPlaywrightMethod({
    method,
    args,
    xpath,
    page,
    context,
}) {
    // console.log("CHECKPOINT 8", method, args, xpath, page.locator);

    const locator = page.locator(`xpath=${xpath}`).first();
    const initialUrl = page.url();

    if (method === "scrollIntoView") {
        try {
            await locator.evaluate((element) => {
                element.scrollIntoView({ behavior: "smooth", block: "center" });
            });
        } catch (e) {
            console.error(e);
            throw Error(e.message);
        }
    } else if (method === "fill" || method === "type") {
        try {
            await locator.fill("");
            await locator.click();
            const text = args[0]?.toString();
            // for (const char of text) {
            //     console.log("CHECKPOINT 11", char);
            //     await page.keyboard.type(char, {
            //         delay: Math.random() * 50 + 25,
            //     });
            // }
            await page.keyboard.type(text);
        } catch (e) {
            console.error(e);
            throw Error(e.message);
        }
    } else if (method === "press") {
        try {
            const key = args[0]?.toString();
            await page.keyboard.press(key);
        } catch (e) {
            console.error(e);
            throw Error(e.message);
        }
    } else if (method === "click") {
        // if the element is a radio button, we should try to click the label instead
        try {
            const isRadio = await locator.evaluate((el) => {
                return el instanceof HTMLInputElement && el.type === "radio";
            });

            const clickArg = args.length ? args[0] : undefined;

            if (isRadio) {
                // if it's a radio button, try to find a label to click
                const inputId = await locator.evaluate((el) => el.id);
                let labelLocator;

                if (inputId) {
                    // if the radio button has an ID, try label[for="thatId"]
                    labelLocator = page.locator(`label[for="${inputId}"]`);
                }
                if (!labelLocator || (await labelLocator.count()) < 1) {
                    // if no label was found or the label doesn't exist, check if
                    // there is an ancestor <label>
                    labelLocator = page
                        .locator(`xpath=${xpath}/ancestor::label`)
                        .first();
                }
                if ((await labelLocator.count()) < 1) {
                    // if still no label, try checking for a following-sibling or preceding-sibling label
                    labelLocator = locator
                        .locator(`xpath=following-sibling::label`)
                        .first();
                    if ((await labelLocator.count()) < 1) {
                        labelLocator = locator
                            .locator(`xpath=preceding-sibling::label`)
                            .first();
                    }
                }
                if ((await labelLocator.count()) > 0) {
                    // if we found a label, click it
                    await labelLocator.click(clickArg);
                } else {
                    // otherwise, just click the radio button itself
                    await locator.click(clickArg);
                }
            } else {
                // here we just do a normal click if it's not a radio input
                const clickArg = args.length ? args[0] : undefined;
                await locator.click(clickArg);
            }
        } catch (e) {
            console.error(e);
            throw Error(e.message);
        }

        // NAVIDNOTE: Should this happen before we wait for locator[method]?
        const newOpenedTab = await Promise.race([
            new Promise((resolve) => {
                // TODO: This is a hack to get the new page
                // We should find a better way to do this
                context.once("page", (page) => resolve(page));
                setTimeout(() => resolve(null), 1_500);
            }),
        ]);

        if (newOpenedTab) {
            await newOpenedTab.close();
            await page.goto(newOpenedTab.url());
            await waitForSettledDom(page);
            // await page.waitForLoadState("domcontentloaded");
            await waitForSettledDom(page);
        }

        await Promise.race([
            waitForSettledDom(page),
            // page.waitForLoadState("networkidle"),
            new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]).catch((e) => {
            console.error(e);
        });

        if (page.url() !== initialUrl) {
            // console.log("new page detected with URL", page.url());
        }
    } else if (typeof locator[method] === "function") {
        // Fallback: any other locator method
        // Log current URL before action

        // Perform the action
        try {
            await locator[method](...args.map((arg) => arg?.toString() || ""));
        } catch (e) {
            console.error(e);
            throw Error(e.message);
        }
    } else {
        throw Error(`Method ${method} not supported`);
    }

    await waitForSettledDom(page);
}

async function getChunksInfo(page) {
    await ensureWebviewJSInjected(page);

    return await page.evaluate(() => {
        return window.getChunksInfo();
    });
}

async function scrollToChunk(page, chunk) {
    await ensureWebviewJSInjected(page);

    await page.evaluate((chunk) => {
        return window.scrollToChunk(chunk);
    }, chunk);
}

async function getElementBoundingBoxesMaster(page, xpaths) {
    await ensureWebviewJSInjected(page);

    const boundingBoxesMap = await page.evaluate((xpaths) => {
        return window.getElementBoundingBoxesMaster(xpaths);
    }, xpaths);

    return boundingBoxesMap;
}

async function getElementBoundingBoxes(page, xpath) {
    try {
        await ensureWebviewJSInjected(page);

        const boundingBoxes = await page.evaluate((xpath) => {
            return window.getElementBoundingBoxes(xpath);
        }, xpath);

        return boundingBoxes;
    } catch (e) {
        console.error(e);
        return [];
    }
}

async function createTextBoundingBoxes(page) {
    await ensureWebviewJSInjected(page);

    await page.evaluate(() => {
        return window.createTextBoundingBoxes();
    });
}

async function processAllOfDom(page) {
    await ensureWebviewJSInjected(page);

    const { outputString, selectorMap } = await page.evaluate(() => {
        return window.processAllOfDom();
    });

    return { outputString, selectorMap };
}

async function restoreDOM(page, dom) {
    await ensureWebviewJSInjected(page);

    await page.evaluate((dom) => {
        window.restoreDOM(dom);
    }, dom);
}

async function getOriginalDOM(page) {
    await ensureWebviewJSInjected(page);

    return await page.evaluate(() => {
        return window.storeDOM();
    });
}

async function processCurrentChunk(page) {
    await ensureWebviewJSInjected(page);

    return await page.evaluate(() => {
        return window.processCurrentChunk();
    });
}

async function processAllDomWithoutScrolling(page) {
    await ensureWebviewJSInjected(page);

    return await page.evaluate(() => {
        return window.processAllDomWithoutScrolling();
    });
}

async function processDom({ page, chunksSeen }) {
    await ensureWebviewJSInjected(page);

    const { outputString, selectorMap, chunk, chunks } = await page.evaluate(
        (chunksSeen) => {
            return window.processDom(chunksSeen);
        },
        chunksSeen
    );

    return { outputString, selectorMap, chunk, chunks };
}

async function debugDom(page) {
    await ensureWebviewJSInjected(page);

    await page.evaluate(() => {
        return window.debugDom(true);
    });
}

async function cleanupDebug(page) {
    await ensureWebviewJSInjected(page);

    await page.evaluate(() => {
        return window.cleanupDebug();
    });
}

async function waitForSettledDom(page) {
    await ensureWebviewJSInjected(page);

    const timeout = 30_000;
    let timeoutHandle;

    try {
        const timeoutPromise = new Promise((resolve) => {
            timeoutHandle = setTimeout(() => {
                console.log("DOM settle timeout exceeded, continuing anyway");
                resolve();
            }, timeout);
        });

        const allPromises = Promise.allSettled([
            page.waitForLoadState("domcontentloaded"),
            page.evaluate(() => {
                return window.waitForDomSettle();
            }),
            page.waitForSelector("body"),
        ]);

        await Promise.race([timeoutPromise, allPromises]);
    } catch (error) {
        console.error("Error in waitForSettledDom:", error);
    } finally {
        clearTimeout(timeoutHandle);
        return; // Ensure we exit after timeout
    }
}

function fillInVariables(text, variables) {
    let processedText = text;
    Object.entries(variables).forEach(([key, value]) => {
        const placeholder = `<|${key.toUpperCase()}|>`;
        processedText = processedText.replace(placeholder, value);
    });
    return processedText;
}

class BrowserableAgent extends BaseAgent {
    PLAYWRIGHT_CONNECTIONS = {};

    async openNewTab({ url, sessionId, connectUrl, browser, context }) {
        if (!browser || !context) {
            console.log("I shouldn't be here");
            let data = await browserService.getPlaywrightBrowser({
                sessionId,
                connectUrl,
            });
            browser = data.browser;
            context = data.context;
        }

        const page = await context.newPage();

        try {
            // add http:// or https:// if not present
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "http://" + url;
            }

            // Navigate to the URL and wait for it to load
            await page.goto(url, { waitUntil: "domcontentloaded" });
        } catch (error) {
            console.error("Error opening new tab:", error);
        }

        // Ensure the page is fully loaded before calling getBrowserTabsAndMetaInformation
        await waitForSettledDom(page);

        // Small delay to stabilize the execution context
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Get tabs info
        const tabsInfo = await getBrowserTabsAndMetaInformation({
            context,
        });

        return {
            tabsInfo,
            newUrl: page.url(),
            newTabId: await getTabIdOfPage(page),
        };
    }

    async htmlToMarkdown({ tabId, sessionId, connectUrl }) {
        const { browser, context } = await browserService.getPlaywrightBrowser({
            sessionId,
            connectUrl,
        });

        const { tabs, tabsString } = await getBrowserTabsAndMetaInformation({
            context,
        });

        const tab = tabs.find((tab) => tab.tabId === tabId);
        if (!tab) {
            throw new Error(
                `Tab with ID ${tabId} not found. Current tabs: ${tabsString}`
            );
        }

        const page = await context.pages()[tabId];

        const pageHtml = await page.evaluate(() => {
            return globalThis.document.documentElement.outerHTML;
        });

        const markdown = NodeHtmlMarkdown.translate(pageHtml);

        return {
            markdown,
            tabsInfo: {
                tabs,
                tabsString,
            },
        };
    }

    constructor() {
        super();
        this.CODE = "BROWSER_AGENT";
        this.DETAILS = {
            description: `What agent does: Gives you an agent that can use browser to do tasks on behalf of user.

When to use: 
- Use this agent if the user explicitly asks you to do something on the browser.

Speciality
- The agent will figure out how to procure a remote browser session + perform tasks like clicking, typing, etc on it.

When NOT to use:
- If a task can be accomplished using other targeted agents. For ex: if there's work with Google Sheets and the user has Google Sheets Agent available. Then use Google Sheets agent instead of browser agent.

Rules: 
- Give this agent clear instructions with as much details as possible.
- If this agent is given a task to do, it will do it in a new browser session. So if there's continuity required, then make sure to provide full task details so that the agent can do it in the same browser session.
- Technically using open_new_tab, read_tab, act_on_tab & extract_from_tab any complex interaction with a browser is possible. So unless you are absolutely sure that the task cannot be done using open_new_tab, read_tab, act_on_tab & extract_from_tab, then use this agent as long as we are working on a website.
- Not every task requires an action. Some of them might already be done. So before performing an action, confirm by extracting the content from the page or reading the page whether the task is already done/ can be done/ needed.
- Few tasks might require multiple action and extractions with different schemas, strategies and attempts. So be patient and try as many different strategies as possible.
- After every act_on_tab, the next step **must be** a read_tab to visually confirm the result of the action before proceeding.
- Do not assume the action succeeded just because the act_on_tab call returned success.

Navigation strategies:
- The tasks might involve finding and navigating multiple pages. So use act, screenshot, extract, read, in loops until some strategy succeeds.
- If you are trying to look for a page in a site. But after repeated search, you are not able to find the right page. One strategy to consider when failing is to search on Google with the constraints and site details. Google is pretty good at finding the right page.
- Whether to do Google search first or to navigate to the site first is a judgement call. If you think the user's problem can be solved by searching on Google, then do it first. If you think the user's problem can be solved by navigating to the site, then do it first.
- Or if the user specifies a url, then you can directly navigate to the url first and then do the task. on failure, you can try to search on Google with the constraints and site details. Vice versa.

IMPORTANT BLOCKERS:
- If you hit a login page, then ask the user to complete the login manually and tell you via text once its done. Once the user confirms that the login is compelte, you can start the task again.
- Deeply analyze the task at every point. Especially once you decide only extraction is left. Since there might be MULTIPLE actions you need to do before you can extract the data. Ex: if the user wants few filters on the page, then you need to perform all the filters before you can extract the data.
- Make sure you are not hallucinating. You are not relying on your own past information and that you are relying on existing data from browsing (dom + images).
- Some times the results might be truncated and full results might be available by interacting with the website (ex: see more buttons). So if you think you need to see the full result to solve user's problem, then figure out the full result by interacting with the page and then extracting the data. If you have all the details, then you can skip going through all the pages. Take the call based on the user's problem and website context.

SPECIAL ELEMENTS:
- DROPDOWNS: Some input boxes are dropdowns. And the dropdowns open up after you type something first. You will have to make sure you type something + select the option from the dropdown to complete the action. Just typing the option won't work.
`,

            input: {
                parameters: {
                    task: "The task to be performed by the agent.",
                },
                required: ["task"],
                types: {
                    task: "string",
                },
            },
            output: {
                parameters: {
                    output: "The output of the agent (answer)",
                },
                required: ["output"],
                types: {
                    output: "string",
                },
            },
        };
    }

    getActions() {
        const baseActions = JSON.parse(JSON.stringify(super.getBaseActions()));

        return {
            ...baseActions,
            // scrape_url: {
            //     description:
            //         "Scrape a url and return the readable text. Opens a URL in a completely new browser session. Use this only if the user specifically asks you to scrape a url.",
            //     input: {
            //         parameters: {
            //             url: "string",
            //         },
            //         required: ["url"],
            //         types: {
            //             url: "string",
            //         },
            //     },
            //     output: {
            //         parameters: {
            //             text: "The output string from the agent",
            //         },
            //         required: ["text"],
            //         types: {
            //             text: "string",
            //         },
            //     },
            // },
            open_new_tab: {
                description: "Open a new tab",
                input: {
                    parameters: {
                        url: "string. This must be a complete well formed URL. Make sure you include the protocal and also the whole site. Part of urls like /soccer won't wokr. You have to include the whole URL. Like https://espn.com/soccer",
                    },
                    required: [
                        "url. Complete url which has protocol, main domain and path",
                    ],
                    types: {
                        url: "string",
                    },
                },
                output: {
                    parameters: {
                        browserState: "string",
                    },
                    required: ["browserState"],
                    types: {
                        browserState: "string",
                    },
                },
            },
            read_tab: {
                description: `Screenshots a tab at current chunk/ scroll position + returns the image and DOM data of the current chunk. 
- Use this when you need to decide strategy on how to proceed with a task or when you need to confirm your strategy or when you need to decide new strategy.
- If you need more context on the page, then call read_tab with with the next chunk number (chunk number is 0 by default. when you call it once, you will get the first fold + how many chunks are present in the page so you can decide to read the next fold or not).
- After every act_on_tab, the next step **must be** a read_tab to visually confirm the result of the action before proceeding.
- You MUST always confirm success of previous interaction via read_tab if it's a UI input. Only proceed with the next field/action once you visually verify the prior one.
`,
                input: {
                    parameters: {
                        tabId: "string",
                        chunkNumber: "number",
                    },
                    required: ["tabId", "chunkNumber"],
                    types: {
                        tabId: "string. This is the unique id of the tab. You would find this in the context of the task.",
                        chunkNumber: "number",
                    },
                },
                output: {
                    parameters: {
                        imageUrl: "string",
                        domData: "string",
                        chunkNumber: "number",
                        totalChunks: "number",
                    },
                    required: [
                        "imageUrl",
                        "domData",
                        "chunkNumber",
                        "totalChunks",
                    ],
                    types: {
                        imageUrl: "string",
                        domData: "string",
                        chunkNumber: "number",
                        totalChunks: "number",
                    },
                },
            },
            act_on_tab: {
                description: `Interacts with a tab. 
- Provide an action like 'Click on the add to cart button', or 'Type 'Browserbase' into the search bar'. 
- Small atomic goals perform the best. Avoid using this to perform complex actions. 
- Since you don't have access to the exact DOM. Give high level task instead of guessing the exact DOM elements. 
- IMPORTANT: instead of saying Click on 'Connect'. Say click on a button that sends a request to connect. 
- Use exact text only if you know the exact text of the element. 
- Don't use it for opening new tabs or urls. Use open_new_tab for that. 
- This function works on the tab directly and not on the browser. So only use this for in-tab actions.
- USE THIS FUNCTION FOR ATOMIC ACTIONS. DONT USE IT FOR COMPLEX ACTIONS (OR MULTIPLE ACTIONS AT ONCE.)
`,
                input: {
                    parameters: {
                        action: "string. The action to perform on the tab.",
                        tabId: "string. The id of the tab to perform the action on. You would find this in the context of the task. Id is the unique id of the tab.",
                        expectationFromAction:
                            "string. What you expect to happen after the action is performed. Be detailed as possible. Also explain how this action fits into the overall plan of action.",
                    },
                    required: ["action", "tabId", "expectationFromAction"],
                    types: {
                        action: "string",
                        tabId: "string. The id of the tab to perform the action on. You would find this in the context of the task. Id is the unique id of the tab.",
                        expectationFromAction: "string",
                    },
                },
                output: {
                    parameters: {
                        actionResult: "string",
                    },
                    required: ["actionResult"],
                    types: {
                        actionResult: "string",
                    },
                },
            },
            extract_from_tab: {
                description: `Extracts text based on instructions from a tab. OR Answers questions based on the content of the tab. 
- Provide schema to extract structured data from the tab. Provide useTextExtract as false if the answer can be extracted from the text of the page. If the dom elements are required to answer, then set to false. 
- If you think there's a URL(or urls) on the page, then extract the URLs using the schema set to URLs. URLs are DOM elements.  So use_text_extract should be false.
- Once the URLs are returned, then use open_new_tab to navigate to the URLs one by one until you find the exact page you need.
- If the page has links, it is almost always a good idea to extract urls in the schema as well. So that to deep down, you can navigate to the exact page you need. And for this you need to set use_text_extract to false.
- ALWAYS extract once you read the tab and you are roughly sure about the content you need.
- IF THERE IS AN IMPORTANT URL THAT WILL GIVE ANSWERS INSTEAD OF THE PAGE ITSELF, THEN EXTRACT THE URL AND THEN USE OPEN_NEW_TAB TO NAVIGATE TO THE URL. DONT TRY TO EXTRACT ANSWERS FROM THE PAGE WHICH HAS URL UNLESS YOU SAW THAT THE PAGE HAS THE ANSWERS.
- EITHER WAY TRY DIFFERENT STRATEGIES TO GET THE ANSWERS.

STRATEGIES FOR DECIDING WHAT SCHEMA TO EXTRACT:
- Almost always extract the same schema as the data table schema format in which user is expecting the information.
- This ensures all the information is captured in one go and you don't miss any information.
- Unless you have a good reason to not do it, always extract the same schema as the data table schema format in which user is expecting the information.
`,
                input: {
                    parameters: {
                        tabId: "string. The id of the tab to extract from. You would find this in the context of the task. Id is the unique id of the tab.",
                        instructions: "string",
                        schema: "array of objects. with each object having three keys: key (string), type (string. or 'array'), description (string). If the type is array, then the description will be the schema of each element in the array. If the type is not array, then the description will be the schema of the key. Ex: if you want to extract the name and age of a person, then the schema will be [{key: 'name', type: 'string', description: 'The name of the person'}, {key: 'age', type: 'number', description: 'The age of the person'}]. If you want to extract list of names with ages, then the schema will be [{key: 'people', type: 'array', description: 'A list of people. Each person has a name and age. The name is a string and the age is a number'}]. If you want to extract the html of a table, then the schema will be [{key: 'table', type: 'string', description: 'The html of a table'}]",
                        useTextExtract:
                            "boolean. Set to true if EVERY part of the schema is based on TEXT ONLY and NO NEED FOR DOM AT ALL. If the dom elements (like URLs or anything else) are required to answer, then set to false. Almost always set this as false UNLESS you really need only the visible content of the page. AND you are absoltuely sure that you can see the visible content of the page.",
                    },
                    required: [
                        "tabId",
                        "instructions",
                        "schema",
                        "useTextExtract",
                    ],
                    types: {
                        tabId: "string. The id of the tab to extract from. You would find this in the context of the task. Id is the unique id of the tab.",
                        instructions: "string",
                        schema: "array of objects. make sure you don't serialize this by yourself. just include the array of objects as it is.",
                        useTextExtract: "boolean. ",
                    },
                },
                output: {
                    parameters: {
                        extractedContent: "string",
                    },
                    required: ["extractedContent"],
                    types: {
                        extractedContent: "string",
                        // summaryOfExtractedContent: "string",
                    },
                },
            },
        };
    }

    getActionFns() {
        const baseActionFns = super.getBaseActionFns();
        return {
            ...baseActionFns,
            // scrape_url: this._action_scrape_url.bind(this),
            process_trigger: this._action_process_trigger.bind(this),
            open_new_tab: this._action_open_new_tab.bind(this),
            act_on_tab: this._action_act_on_tab.bind(this),
            extract_from_tab: this._action_extract_from_tab.bind(this),
            read_tab: this._action_read_tab.bind(this),
        };
    }

    async _action_scrape_url({ aiData, jarvis, runId, nodeId, threadId }) {
        const { url } = aiData;

        await jarvis.updateNodeStatus({
            agentCode: this.CODE,
            runId,
            nodeId,
            status: "Scraping url",
        });

        const nodeInfo = await jarvis.getNodeInfo({ runId, nodeId });

        const { sessionId, connectUrl } = nodeInfo.private_data;

        const scrapedText = await scrapeUrl({ sessionId, connectUrl, url });

        const completeScrapedText = `
=========SCRAPED CONTENT STARTS============
${scrapedText.data.markdown}
=========SCRAPED CONTENT ENDS============
=========METADATA STARTS============
${Object.keys(scrapedText.data.metadata)
    .map((key) => `${key}: ${scrapedText.data.metadata[key]}`)
    .join("\n")}
=========METADATA ENDS============
`;
        // add to agent logs
        await jarvis.updateNodeAgentLog({
            agentCode: this.CODE,
            runId,
            nodeId,
            messages: [
                {
                    role: "jarvis",
                    content: completeScrapedText,
                },
            ],
        });

        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Scraped url: ${url}`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: completeScrapedText,
                                    name: "Scraped content",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        await jarvis.updateNodeUserLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Scraped url: ${url}`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: completeScrapedText,
                                    name: "Scraped content",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        await jarvis.scheduleNodeLooper({
            runId,
            nodeId,
            threadId,
            agentCode: this.CODE,
            delay: 0,
            sync: true,
        });

        return {
            text: scrapedText,
        };
    }

    async createPlanOfAction({ runId, nodeId, jarvis, task, threadId }) {
        const possibleActions = Object.keys(this.getActions());

        const messages = [
            {
                role: "system",
                content: `
You are a helpful assistant that creates a plan of action for how a browser agent should perform a given task.
                `,
            },
            {
                role: "user",
                content: `
Task: ${task}

Available Tools:
${possibleActions
    .map(
        (id) => `== ACTION ${id} == 
Description: 
${this.getActions()[id].description}

Input: 
${JSON.stringify(this.getActions()[id].input, null, 2)}

Output: 
${JSON.stringify(this.getActions()[id].output, null, 2)}
`
    )
    .join("\n\n")}

Output Format: (JSON)
{
    "plan": "string. Detailed rough plan of action for the browser agent to perform the task using the provided tools."
}

Example:
{
    "plan": "Open a new tab and navigate to https://www.google.com"
}

ONLY OUTPUT THE JSON. NO OTHER TEXT.`,
            },
        ];

        const response = await callOpenAICompatibleLLMWithRetry({
            messages,
            models: [
                "gemini-2.5-flash",
                "deepseek-chat",
                "gpt-4o-mini",
                "claude-3-5-haiku",
                "qwen-plus",
            ],
            max_tokens: 3000,
            metadata: {
                runId,
                nodeId,
                agentCode: this.CODE,
                flowId: jarvis.flow_id,
                usecase: "plan_of_action",
                accountId: jarvis.account_id,
                threadId,
            },
            max_attempts: 3,
        });

        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Created a plan of action.`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: response.plan,
                                    name: "Plan of action",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        await jarvis.updateNodeUserLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Created a plan of action.`,
                        },
                    ],
                },
            ],
        });

        const { plan } = response;

        return plan;
    }

    async _init({
        runId,
        nodeId,
        threadId,
        input, // to start the agent
        jarvis,
    }) {
        await jarvis.updateNodeStatus({
            agentCode: this.CODE,
            runId,
            nodeId,
            status: "Getting a browser session",
        });

        // any re-usable data can be stored here.
        await jarvis.updateNodeKeyVal({
            agentCode: this.CODE,
            runId,
            nodeId,
            data: {},
        });

        // Create new eventId for the browser session
        const eventId = await jarvis.generateUUID();

        const plan = await this.createPlanOfAction({
            runId,
            nodeId,
            threadId,
            jarvis,
            task: input,
        });

        await jarvis.saveNodePrivateData({
            runId,
            nodeId,
            data: {
                eventId,
                planOfAction: plan,
                mainTask: input,
            },
        });

        // VERSION 2 -> One browser session per node
        await jarvis.addTriggerForNode({
            runId,
            nodeId,
            triggerWait: `event.once|${eventId}|`,
        });

        needNewSession({
            eventId,
            user_id: jarvis.user_id,
            account_id: jarvis.account_id,
            runId,
            flowId: jarvis.flow_id,
            threadId,
        });

        // VERSION 1 -> One browser session per thread
        // const threadData = await jarvis.getThreadData({ runId, threadId });

        // // if there is a sessionId in runPrivateData, then we need to use the same session
        // const { sessionId, connectUrl, liveUrl } = threadData;

        // if (sessionId) {
        //     // save these deets in the node private data
        //     await jarvis.saveNodePrivateData({
        //         runId,
        //         nodeId,
        //         data: {
        //             sessionId,
        //             connectUrl,
        //             liveUrl,
        //         },
        //     });

        //     await jarvis.updateNodeLiveStatus({
        //         runId,
        //         nodeId,
        //         liveStatus: liveUrl,
        //     });

        //     // schedule looper
        //     await jarvis.scheduleNodeLooper({
        //         runId,
        //         nodeId,
        //         threadId,
        //         agentCode: this.CODE,
        //         delay: 0,
        //         input: input,
        //     });
        // } else {
        //     await jarvis.addTriggerForNode({
        //         runId,
        //         nodeId,
        //         triggerWait: `event.once|${eventId}|`,
        //     });

        //     needNewSession({
        //         eventId,
        //         user_id: jarvis.user_id,
        //         account_id: jarvis.account_id,
        //         runId,
        //         flowId: jarvis.flow_id,
        //         threadId,
        //     });
        // }
    }

    async _action_process_trigger({ aiData, nodeId, runId, threadId, jarvis }) {
        const { triggerData } = aiData;

        const { sessionId, connectUrl, liveUrl } = triggerData;

        await jarvis.updateNodeLiveStatus({
            runId,
            nodeId,
            liveStatus: liveUrl,
        });

        const nodeInfo = await jarvis.getNodeInfo({ runId, nodeId });

        await jarvis.saveNodePrivateData({
            runId,
            nodeId,
            data: Object.assign(nodeInfo.private_data || {}, {
                sessionId,
                connectUrl,
                liveUrl,
            }),
        });

        // save this in the thread data
        // In version 1, this helps reuse the same browser session and also close the thread when the thread is done.
        // In version 2, this helps in case of node crashing. Then thread level session cleanup is done.
        await jarvis.updateThreadData({
            runId,
            threadId,
            data: {
                sessionId,
                connectUrl,
                liveUrl,
                eventId: nodeInfo.private_data.eventId,
            },
        });

        // now we schedule looper
        // Delay here is decided deterministically by agent creator. Ex: if any rate limits are present for different models or users.
        await jarvis.scheduleNodeLooper({
            runId,
            nodeId,
            threadId,
            input: nodeInfo.input,
            agentCode: this.CODE,
            delay: 0,
            sync: true,
        });

        return {
            text: "Processed trigger",
        };
    }

    async _action_open_new_tab({ aiData, jarvis, runId, nodeId, threadId }) {
        const nodeInfo = await jarvis.getNodeInfo({ runId, nodeId });

        const { sessionId, connectUrl } = nodeInfo.private_data;

        const { url } = aiData;

        await jarvis.updateNodeStatus({
            agentCode: this.CODE,
            runId,
            nodeId,
            status: "Opening new tab",
        });

        await jarvis.updateNodeUserLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Opening a new tab.`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: url,
                                    name: "URL",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Opening a new tab.`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: url,
                                    name: "URL",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        const { browser, context } = await browserService.getPlaywrightBrowser({
            sessionId,
            connectUrl,
        });

        try {
            const { tabsInfo, newUrl } = await this.openNewTab({
                url,
                browser,
                context,
            });

            await jarvis.updateNodeAgentLog({
                agentCode: this.CODE,
                runId,
                nodeId,
                messages: [
                    {
                        role: "jarvis",
                        content: `Opened a new tab: ${newUrl}`,
                    },
                    {
                        role: "jarvis",
                        content: tabsInfo.tabsString,
                    },
                ],
            });

            const tab = tabsInfo.tabs.find((tab) => tab.url === newUrl);

            if (tab) {
                const page = await context.pages()[tab.index];

                await scrollToChunk(page, 0);

                // take a screenshot
                const { success, imageUrl, privateImageUrl } =
                    await screenshotHelper({
                        page,
                        runId,
                        nodeId,
                        threadId,
                        jarvis,
                    });

                await waitForSettledDom(page);
                await debugDom(page);

                // chunksSeen is the chunks that have been seen so far.
                // if chunkNumber is 0, then chunksSeen is []
                // if chunkNumber is 1, then chunksSeen is [0]
                // if chunkNumber is 2, then chunksSeen is [0, 1]
                const chunksSeen = Array.from({ length: 0 }, (_, i) => i);

                const { outputString, selectorMap, chunk, chunks } =
                    await processDom({
                        page,
                        chunksSeen,
                    });

                await scrollToChunk(page, 0);
                await cleanupDebug(page);

                await jarvis.updateNodeAgentLog({
                    agentCode: this.CODE,
                    runId,
                    nodeId,
                    messages: [
                        {
                            role: "jarvis",
                            content: imageUrl
                                ? `Screenshot taken of the new tab.
    **ImageUrl**: ${imageUrl}`
                                : `Unable to take screenshot of the new tab.`,
                        },
                        {
                            role: "jarvis",
                            content: `For the tab:
    AVAILABLE CHUNKS (VERY IMPORTANT INFORMATION TO DECIDE HOW MANY SCROLLS ARE THERE TO READ): ${chunks.join(
        ", "
    )}`,
                        },
                        {
                            role: "jarvis",
                            content: `DOM OF THE PAGE AT THE CURRENT CHUNK:
    ${outputString || "No DOM available"}`,
                        },
                    ],
                });

                await jarvis.updateNodeUserLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: `Opened a new tab.`,
                                    associatedData: [
                                        {
                                            type: "image",
                                            url: imageUrl,
                                            name: "Screenshot",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                });

                await jarvis.updateNodeDebugLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: `Opened a new tab.`,
                                    associatedData: [
                                        {
                                            type: "image",
                                            url: imageUrl,
                                            name: "Screenshot",
                                        },
                                        {
                                            type: "markdown",
                                            markdown: url,
                                            name: "URL",
                                        },
                                        {
                                            type: "code",
                                            code: {
                                                DOM: outputString,
                                            },
                                            name: "DOM",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                });

                if (imageUrl) {
                    await jarvis.updateNodeAgentLog({
                        agentCode: this.CODE,
                        runId,
                        nodeId,
                        messages: [
                            {
                                role: "jarvis",
                                content: [
                                    {
                                        type: "image_url",
                                        image_url: {
                                            url: privateImageUrl,
                                        },
                                    },
                                ],
                            },
                        ],
                    });
                }
            }
        } catch (error) {
            console.error(error);
            await jarvis.updateNodeAgentLog({
                agentCode: this.CODE,
                runId,
                nodeId,
                messages: [
                    {
                        role: "jarvis",
                        content: `Error opening new tab.
**Error**: ${error.message}`,
                    },
                ],
            });
        }

        await jarvis.scheduleNodeLooper({
            runId,
            nodeId,
            threadId,
            agentCode: this.CODE,
            delay: 0,
            sync: true,
        });
    }

    async _action_html_to_markdown({
        aiData,
        jarvis,
        runId,
        nodeId,
        threadId,
    }) {
        const { tabId } = aiData;

        const nodeInfo = await jarvis.getNodeInfo({ runId, nodeId });

        const { sessionId, connectUrl } = nodeInfo.private_data;

        try {
            const { markdown, tabsInfo } = await this.htmlToMarkdown({
                tabId,
                sessionId,
                connectUrl,
            });

            // truncate markdown to 2000 characters
            const truncatedMarkdown = markdown.slice(0, 2000);

            await jarvis.updateNodeAgentLog({
                agentCode: this.CODE,
                runId,
                nodeId,
                messages: [
                    {
                        role: "jarvis",
                        content: `Converted html of tab ${tabId} to markdown:
========== MARKDOWN STARTS ==========
${truncatedMarkdown}
========== MARKDOWN ENDS ==========`,
                    },
                    {
                        role: "jarvis",
                        content: tabsInfo.tabsString,
                    },
                ],
            });
        } catch (error) {
            console.error(error);
            await jarvis.updateNodeAgentLog({
                agentCode: this.CODE,
                runId,
                nodeId,
                messages: [
                    {
                        role: "jarvis",
                        content: `Error converting html to markdown.
**Error**: ${error.message}`,
                    },
                ],
            });
        }

        await jarvis.scheduleNodeLooper({
            runId,
            nodeId,
            threadId,
            agentCode: this.CODE,
            delay: 0,
            sync: true,
        });
    }

    async _action_extract_from_tab({
        aiData,
        jarvis,
        runId,
        nodeId,
        threadId,
    }) {
        let {
            tabId,
            instructions,
            schema,
            useTextExtract,
            saveToDb,
            tempSave,
            saveUntil,
        } = aiData;

        try {
            if (typeof schema === "string") {
                schema = JSON.parse(schema);
            } else if (!Array.isArray(schema) && typeof schema === "object") {
                schema = [schema];
            }
        } catch (error) {
            console.error(error);
            await jarvis.updateNodeAgentLog({
                agentCode: this.CODE,
                runId,
                nodeId,
                messages: [
                    {
                        role: "jarvis",
                        content: `Error parsing schema.
**Error**: ${error.message}`,
                    },
                ],
            });

            await jarvis.scheduleNodeLooper({
                runId,
                nodeId,
                threadId,
                agentCode: this.CODE,
                delay: 0,
                sync: true,
            });
            return;
        }

        await jarvis.updateNodeUserLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Extracting data from tab.`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: tabId,
                                    name: "Tab ID",
                                },
                                {
                                    type: "markdown",
                                    markdown: instructions,
                                    name: "Instructions",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Extracting data from tab.`,
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: tabId,
                                    name: "Tab ID",
                                },
                                {
                                    type: "markdown",
                                    markdown: instructions,
                                    name: "Instructions",
                                },
                                {
                                    type: "code",
                                    code: {
                                        schema,
                                        usingTextExtract: useTextExtract,
                                    },
                                    name: "Schema",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        const nodeInfo = await jarvis.getNodeInfo({ runId, nodeId });

        const { sessionId, connectUrl } = nodeInfo.private_data;

        const { browser, context } = await browserService.getPlaywrightBrowser({
            sessionId,
            connectUrl,
        });

        try {
            const {
                success,
                message,
                extractedContent,
                summaryOfExtractedContent,
            } = await extractHelper({
                browser,
                context,
                tabId,
                instructions,
                schema,
                useTextExtract,
                jarvis,
                runId,
                nodeId,
                threadId,
            });

            if (success) {
                // TODO: (SG)
                // Implement saveToDb, tempSave, saveUntil
                // If they are present, then we send summary of extract data + file ids of the saved files instead of sending the complete extracted data
                // Removed summary of extracted content from the output since it is not needed + it is removing too much details

                await jarvis.updateNodeAgentLog({
                    agentCode: this.CODE,
                    runId,
                    nodeId,
                    messages: [
                        {
                            role: "jarvis",
                            content: `Extracted data from tab.
**TabId**: ${tabId}
**Extracted Data**: 
${extractedContent}`,
                        },
                    ],
                });
            } else {
                await jarvis.updateNodeAgentLog({
                    agentCode: this.CODE,
                    runId,
                    nodeId,
                    messages: [
                        {
                            role: "jarvis",
                            content: `Error extracting data from tab.
**TabId**: ${tabId}
**Error**: ${message}`,
                        },
                    ],
                });
            }
        } catch (error) {
            await jarvis.updateNodeUserLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: `Error extracting data from tab.`,
                                associatedData: [
                                    {
                                        type: "markdown",
                                        markdown: tabId,
                                        name: "Tab ID",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });

            await jarvis.updateNodeDebugLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: `Error extracting data from tab.`,
                                associatedData: [
                                    {
                                        type: "markdown",
                                        markdown: tabId,
                                        name: "Tab ID",
                                    },
                                    {
                                        type: "markdown",
                                        markdown: error.message,
                                        name: "Error",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });

            console.error(error);
            await jarvis.updateNodeAgentLog({
                agentCode: this.CODE,
                runId,
                nodeId,
                messages: [
                    {
                        role: "jarvis",
                        content: `Error extracting text from tab.
**TabId**: ${tabId}
**Error**: ${error.message}`,
                    },
                ],
            });
        }

        const { tabs, tabsString } = await getBrowserTabsAndMetaInformation({
            context,
        });

        const tab = tabs.find((tab) => tab.tabId === tabId);

        if (!tab) {
            await jarvis.updateNodeAgentLog({
                agentCode: this.CODE,
                runId,
                nodeId,
                messages: [
                    {
                        role: "jarvis",
                        content: `Tab with ID ${tabId} not found. Current tabs: ${tabsString}`,
                    },
                ],
            });
        } else {
            const page = await context.pages()[tab.index];

            /* Add the screenshot of the tab to the agent log */
            const { success, imageUrl, privateImageUrl } =
                await screenshotHelper({
                    page,
                    runId,
                    nodeId,
                    jarvis,
                    threadId,
                });

            await jarvis.updateNodeAgentLog({
                agentCode: this.CODE,
                runId,
                nodeId,
                messages: [
                    {
                        role: "jarvis",
                        content: [
                            {
                                type: "image_url",
                                image_url: {
                                    url: privateImageUrl,
                                },
                            },
                        ],
                    },
                ],
            });
        }

        await jarvis.scheduleNodeLooper({
            runId,
            nodeId,
            threadId,
            agentCode: this.CODE,
            delay: 0,
            sync: true,
        });
    }

    async _action_act_on_tab({ aiData, threadId, jarvis, runId, nodeId }) {
        const { tabId, action, expectationFromAction } = aiData;
        const nodeInfo = await jarvis.getNodeInfo({ runId, nodeId });
        const { sessionId, connectUrl, mainTask } = nodeInfo.private_data;

        const { browser, context } = await browserService.getPlaywrightBrowser({
            sessionId,
            connectUrl,
        });

        try {
            // const { success, message } = await actHelper({
            //     browser,
            //     context,
            //     tabId,
            //     action,
            //     expectationFromAction,
            //     jarvis,
            //     runId,
            //     nodeId,
            //     threadId,
            // });

            const { success, message, steps } = await simpleActionHelper({
                browser,
                context,
                action,
                expectationFromAction,
                jarvis,
                runId,
                nodeId,
                threadId,
                tabId,
                mainTask,
            });

            // const { success, message } = await actHelperWithVision({
            //     browser,
            //     context,
            //     action,
            //     expectationFromAction,
            //     jarvis,
            //     runId,
            //     nodeId,
            // });

            await jarvis.updateNodeAgentLog({
                agentCode: this.CODE,
                runId,
                nodeId,
                messages: [
                    {
                        role: "jarvis",
                        content: success
                            ? `Action completed successfully.
**Action**: ${action}`
                            : `Action failed.
**Action**: ${action}`,
                    },
                    { role: "jarvis", content: message },
                    {
                        role: "jarvis",
                        content: `Steps performed: ${JSON.stringify(steps)}`,
                    },
                ],
            });

            await jarvis.updateNodeUserLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: success
                                    ? `Action completed successfully.`
                                    : `Action failed.`,
                            },
                        ],
                    },
                ],
            });

            await jarvis.updateNodeDebugLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: success
                                    ? `Action completed successfully.`
                                    : `Action failed.`,
                                associatedData: [
                                    {
                                        type: "markdown",
                                        markdown: message,
                                        name: "Message",
                                    },
                                    {
                                        type: "code",
                                        code: {
                                            steps,
                                        },
                                        name: "Steps",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });
        } catch (error) {
            console.error(error);
            await jarvis.updateNodeAgentLog({
                agentCode: this.CODE,
                runId,
                nodeId,
                messages: [
                    {
                        role: "jarvis",
                        content: `Error performing action.
**Action**: ${action}
**TabId**: ${tabId}
**Error**: ${error.message}`,
                    },
                ],
            });

            await jarvis.updateNodeUserLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: `Error performing action.`,
                            },
                        ],
                    },
                ],
            });

            await jarvis.updateNodeDebugLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: `Error performing action.`,
                                associatedData: [
                                    {
                                        type: "markdown",
                                        markdown: error.message,
                                        name: "Error",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });
        }

        await jarvis.scheduleNodeLooper({
            runId,
            nodeId,
            threadId,
            agentCode: this.CODE,
            delay: 0,
            sync: true,
        });
    }

    async _action_read_tab({ aiData, threadId, jarvis, runId, nodeId }) {
        try {
            let { tabId, chunkNumber } = aiData;
            chunkNumber = chunkNumber || 0;
            chunkNumber = Number(chunkNumber);

            const nodeInfo = await jarvis.getNodeInfo({ runId, nodeId });

            const { sessionId, connectUrl } = nodeInfo.private_data;

            const { browser, context } =
                await browserService.getPlaywrightBrowser({
                    sessionId,
                    connectUrl,
                });

            const { tabs, tabsString } = await getBrowserTabsAndMetaInformation(
                {
                    context,
                }
            );

            let messages = [];

            await jarvis.updateNodeUserLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: `Reading tab.`,
                                associatedData: [
                                    {
                                        type: "markdown",
                                        markdown: tabId,
                                        name: "Tab ID",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });

            await jarvis.updateNodeDebugLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: `Reading tab.`,
                                associatedData: [
                                    {
                                        type: "markdown",
                                        markdown: tabId,
                                        name: "Tab ID",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });

            const tab = tabs.find((tab) => tab.tabId === tabId);
            if (!tab) {
                await jarvis.updateNodeAgentLog({
                    agentCode: this.CODE,
                    runId,
                    nodeId,
                    messages: [
                        {
                            role: "user",
                            content: `Tab with ID ${tabId} not found. Current tabs: ${tabsString}`,
                        },
                    ],
                });

                await jarvis.updateNodeDebugLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: `Tab not found.`,
                                    associatedData: [
                                        {
                                            type: "code",
                                            code: {
                                                tabs,
                                            },
                                            name: "Current Tabs",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                });

                await jarvis.updateNodeUserLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: `Tab not found.`,
                                },
                            ],
                        },
                    ],
                });
            } else {
                const page = await context.pages()[tab.index];

                await scrollToChunk(page, chunkNumber);

                // take a screenshot
                const { success, imageUrl, privateImageUrl } =
                    await screenshotHelper({
                        page,
                        runId,
                        nodeId,
                        jarvis,
                        threadId,
                    });

                const { tabs: tabsInfo, tabsString } =
                    await getBrowserTabsAndMetaInformation({
                        context,
                    });

                await waitForSettledDom(page);
                await debugDom(page);

                const chunksInfo = await getChunksInfo(page);
                const { outputString, selectorMap } = await processCurrentChunk(
                    page
                );
                const { currentChunk, totalChunks } = chunksInfo;

                const chunks = Array.from(
                    { length: totalChunks },
                    (_, i) => i + 1
                );

                await cleanupDebug(page);

                await jarvis.updateNodeAgentLog({
                    agentCode: this.CODE,
                    runId,
                    nodeId,
                    messages: [
                        {
                            role: "jarvis",
                            content: imageUrl
                                ? `Screenshot Taken.
**TabId**: ${tabId}
**ImageUrl**: ${imageUrl}`
                                : `Unable to take screenshot of the tab.`,
                        },
                        {
                            role: "jarvis",
                            content: tabsString,
                        },
                        {
                            role: "jarvis",
                            content: `For the tab:
CURRENT CHUNK: ${chunkNumber}
AVAILABLE CHUNKS (VERY IMPORTANT INFORMATION TO DECIDE HOW MANY SCROLLS ARE THERE TO READ: ${chunks.join(
                                ", "
                            )}`,
                        },
                        {
                            role: "jarvis",
                            content: `DOM OF THE PAGE AT THE CURRENT CHUNK:
${outputString || "No DOM available"}`,
                        },
                    ],
                });

                await jarvis.updateNodeUserLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: "Read tab.",
                                    associatedData: [
                                        {
                                            type: "image",
                                            url: imageUrl,
                                            name: "Screenshot",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                });

                await jarvis.updateNodeDebugLog({
                    runId,
                    nodeId,
                    threadId,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: "Read tab.",
                                    associatedData: [
                                        {
                                            type: "image",
                                            url: imageUrl,
                                            name: "Screenshot",
                                        },
                                        {
                                            type: "code",
                                            code: {
                                                tabs,
                                            },
                                            name: "Current Tabs",
                                        },
                                        {
                                            type: "code",
                                            code: {
                                                dom: outputString,
                                            },
                                            name: "DOM",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                });

                if (imageUrl) {
                    await jarvis.updateNodeAgentLog({
                        agentCode: this.CODE,
                        runId,
                        nodeId,
                        messages: [
                            {
                                role: "jarvis",
                                content: [
                                    {
                                        type: "image_url",
                                        image_url: {
                                            url: privateImageUrl,
                                        },
                                    },
                                ],
                            },
                        ],
                    });
                }
            }
        } catch (error) {
            console.error(error);
            await jarvis.updateNodeAgentLog({
                agentCode: this.CODE,
                runId,
                nodeId,
                messages: [
                    {
                        role: "jarvis",
                        content: `Error reading tab: ${error.message}`,
                    },
                ],
            });

            await jarvis.updateNodeDebugLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: `Error reading tab.`,
                        associatedData: [
                            {
                                type: "code",
                                code: {
                                    error: error.message,
                                },
                            },
                        ],
                    },
                ],
            });

            await jarvis.updateNodeUserLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: `Error reading tab.`,
                    },
                ],
            });
        }

        await jarvis.scheduleNodeLooper({
            runId,
            nodeId,
            threadId,
            agentCode: this.CODE,
            delay: 0,
            sync: true,
        });
    }

    async _looper({ input, nodeId, threadId, runId, jarvis }) {
        await jarvis.updateNodeStatus({
            agentCode: this.CODE,
            runId,
            nodeId,
            status: "Processing browser agent",
        });

        const nodeInfo = await jarvis.getNodeInfo({ runId, nodeId });

        const { sessionId, connectUrl, planOfAction } = nodeInfo.private_data;

        const { browser, context } = await browserService.getPlaywrightBrowser({
            sessionId,
            connectUrl,
        });

        const { tabs, tabsString } = await getBrowserTabsAndMetaInformation({
            context,
        });

        const action = await jarvis.decideAction({
            runId,
            agentCode: this.CODE,
            nodeId,
            threadId,
            input: `${input}

        ROUGH PLAN OF ACTION:
${planOfAction}

CURRENT BROWSER TABS:
${tabsString}
            `,
            possibleActions: Object.keys(this.getActions()),
        });

        const { actionCode, aiData } = action;

        const actionId = await jarvis.generateUUID();

        // schedule to run the action
        await jarvis.scheduleAction({
            runId,
            agentCode: this.CODE,
            nodeId,
            threadId,
            actionCode,
            actionId,
            aiData,
            delay: aiData.delay || 0,
            sync: true,
        });
    }

    async _action_end({ jarvis, aiData, runId, nodeId, threadId }) {
        await jarvis.updateNodeLiveStatus({
            runId,
            nodeId,
            liveStatus: "",
        });

        let { reasoning, output, parameters } = aiData;

        if (
            parameters &&
            !output &&
            !reasoning &&
            typeof parameters === "object" &&
            parameters.reasoning &&
            parameters.output
        ) {
            output = parameters.output;
            reasoning = parameters.reasoning;
        }

        // get private_data
        const nodeInfo = await jarvis.getNodeInfo({ runId, nodeId });
        const {
            eventId,
            sessionId,
            connectUrl,
            aiData: aiDataFromNode,
        } = nodeInfo.private_data;

        // In version 1, we don't close the browser session here. That happens when thread is ended.

        // In version 2, we close the browser session here.
        try {
            console.log(
                "DONE WITH SESSION 3",
                jarvis.user_id,
                jarvis.account_id,
                eventId,
                sessionId
            );

            await doneWithSession({
                user_id: jarvis.user_id,
                account_id: jarvis.account_id,
                eventId,
                sessionId,
            });
        } catch (error) {
            console.log("Error closing browser session 2. Moving on.", error);
        }

        await jarvis.updateRunLiveStatus({
            runId,
            liveStatus: "",
        });

        await jarvis.updateNodeUserLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: output,
                        },
                    ],
                },
            ],
        });

        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "Browser agent finished.",
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: output,
                                    name: "Result",
                                },
                                {
                                    type: "markdown",
                                    markdown: reasoning,
                                    name: "Reasoning",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        await jarvis.endNode({
            runId,
            nodeId,
            threadId,
            status: "completed",
            output,
            reasoning,
        });
    }
}

const browserableAgent = new BrowserableAgent();

module.exports = {
    agent: browserableAgent,
    BrowserableAgent,
};
