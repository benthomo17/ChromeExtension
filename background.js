const PROVIDERS = {
  gemini: {
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    defaultModel: "gemini-3-flash-preview"
  },
  groq: {
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "moonshotai/kimi-k2-instruct"
  },
  openai: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini"
  }
};

// Create context menu on install (remove existing first to avoid duplicates)
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "sendToAI",
      title: "Send to AI (Text only)",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "sendToAIWithImage",
      title: "Send to AI (With image)",
      contexts: ["selection"]
    });
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "sendToAI" && info.selectionText) {
    sendToAI(info.selectionText, tab.id);
  } else if (info.menuItemId === "sendToAIWithImage" && info.selectionText) {
    captureAndAnalyze(info.selectionText, tab.id);
  }
});

// Store selections from all frames, keyed by tabId
const storedSelections = new Map();

// Handle messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "analyzeText" && request.text) {
    sendToAI(request.text, sender.tab.id);
  } else if (request.action === "analyzeWithImage" && request.text) {
    // Capture screenshot and send with text
    captureAndAnalyze(request.text, sender.tab.id);
  } else if (request.action === "storeSelection" && request.text) {
    // Store selection immediately when user selects text
    // Keep the longest selection (in case multiple frames report)
    const tabId = sender.tab.id;
    const current = storedSelections.get(tabId) || "";
    if (request.text.length >= current.length) {
      storedSelections.set(tabId, request.text);
    }
  } else if (request.action === "collectAndAnalyze") {
    // Use the stored selection as fallback
    const tabId = sender.tab.id;
    const text = storedSelections.get(tabId);
    if (text) {
      sendToAI(text, tabId);
      storedSelections.delete(tabId);
    } else {
      chrome.tabs.sendMessage(tabId, {
        action: "showPopup",
        content: "No text selected",
        error: true
      });
    }
  }
});

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === "send-to-ai") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "getSelection" }, (response) => {
          if (response && response.text) {
            sendToAI(response.text, tabs[0].id);
          }
        });
      }
    });
  }
});

async function captureAndAnalyze(text, tabId) {
  try {
    // Capture the visible tab as a screenshot
    const screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    // Send to AI with image
    await sendToAI(text, tabId, screenshot);
  } catch (error) {
    chrome.tabs.sendMessage(tabId, {
      action: "showPopup",
      content: `Screenshot error: ${error.message}`,
      error: true
    });
  }
}

async function sendToAI(text, tabId, imageDataUrl = null) {
  // Show loading state
  chrome.tabs.sendMessage(tabId, { action: "showPopup", content: "...", loading: true });

  try {
    // Get settings from storage
    const settings = await chrome.storage.sync.get([
      "provider", "model", "apiKey", "customEndpoint", "customModel"
    ]);

    const provider = settings.provider || "groq";
    const apiKey = settings.apiKey;

    if (!apiKey) {
      chrome.tabs.sendMessage(tabId, {
        action: "showPopup",
        content: "API key not set. Right-click extension > Options",
        error: true
      });
      return;
    }

    // Determine endpoint and model
    let endpoint, model;
    if (provider === "custom") {
      endpoint = settings.customEndpoint;
      model = settings.customModel;
    } else {
      const config = PROVIDERS[provider];
      endpoint = config.endpoint;
      model = settings.model || config.defaultModel;
    }

    const systemPrompt = imageDataUrl
      ? `You analyze questions with text and images to identify the correct answer. Rules:

MULTIPLE CHOICE WITH IMAGE:
1. Examine BOTH the text and image carefully
2. Identify the question and all answer choices (from text OR visible in image)
3. Determine the correct answer based on the question context
4. Output ONLY the correct option: number/letter + answer text
5. Format: "1) True" or "B) Photosynthesis" or "C) Mitochondria"
6. Ignore "Selected"/"Unselected" markers
7. NO explanations - ONLY the correct answer

IMAGE ANALYSIS:
- Look for diagrams, charts, graphs, or visual information
- Read any text visible in the image
- Use visual context to determine the correct answer

ALWAYS: Just output the correct answer - nothing else`
      : `You answer multiple choice questions and solve math problems. Rules:

MULTIPLE CHOICE:
1. Output the correct option number/letter followed by the option text
2. Ignore any "Selected"/"Unselected" markers - they are irrelevant
3. Format: "1) True" or "B) Photosynthesis"
4. NO explanations - just the number and the option text exactly as shown

MATH PROBLEMS:
1. Solve conversions (fractions, decimals, percentages, mixed numbers)
2. Solve equations and fill-in-the-box problems
3. Show only the final answer in simplest form
4. For fractions: reduce to simplest terms (e.g., "3/4" not "6/8")
5. For mixed numbers: use format like "2 1/3"
6. For fill-in-the-box: just provide the number/value

ALWAYS: Keep answers concise - NO explanations or reasoning`;

    let response, data, answer;

    if (provider === "gemini") {
      // Gemini API format - endpoint includes model name
      const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      const parts = [];

      if (imageDataUrl) {
        // Extract base64 data from data URL
        const base64Data = imageDataUrl.split(',')[1];
        parts.push({ text: systemPrompt + "\n\n" + text });
        parts.push({
          inline_data: {
            mime_type: "image/png",
            data: base64Data
          }
        });
      } else {
        parts.push({ text: systemPrompt + "\n\n" + text });
      }

      response = await fetch(geminiEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{ parts }]
        })
      });

      data = await response.json();

      if (data.error) {
        throw new Error(data.error.message);
      }

      answer = data.candidates[0].content.parts[0].text.trim();
    } else {
      // OpenAI-compatible API format (Groq, OpenAI, custom)
      const messages = [
        { role: "system", content: systemPrompt }
      ];

      if (imageDataUrl) {
        // Vision API format with image
        messages.push({
          role: "user",
          content: [
            { type: "text", text: text },
            {
              type: "image_url",
              image_url: {
                url: imageDataUrl
              }
            }
          ]
        });
      } else {
        messages.push({ role: "user", content: text });
      }

      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          max_tokens: imageDataUrl ? 150 : 50,
          temperature: 0.1
        })
      });

      data = await response.json();

      if (data.error) {
        throw new Error(data.error.message);
      }

      answer = data.choices[0].message.content.trim();
    }
    chrome.tabs.sendMessage(tabId, { action: "showPopup", content: answer });

  } catch (error) {
    chrome.tabs.sendMessage(tabId, {
      action: "showPopup",
      content: `Error: ${error.message}`,
      error: true
    });
  }
}
