const PROVIDERS = {
  gemini: {
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    defaultModel: "gemini-2.0-flash"
  },
  groq: {
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "moonshotai/kimi-k2-instruct"
  },
  openai: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini"
  },
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "google/gemini-flash-1.5"
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
      captureAndAnalyze(text, tabId);
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
      if (!config) {
        throw new Error(`Invalid provider: '${provider}'. Please re-select your provider in the extension options.`);
      }
      endpoint = config.endpoint;
      model = settings.model || config.defaultModel;
    }

    const systemPrompt = imageDataUrl
      ? `CRITICAL: You MUST output ONLY the correct answer choice, nothing else.

Analyze the question and image to find the correct answer.
Output format: "A) Answer text" or "1) Answer text" or just the answer text.
NO explanations. NO reasoning. NO additional text whatsoever.
Output the answer choice ONLY.`
      : `CRITICAL: You MUST output ONLY the correct answer choice, nothing else.

For multiple choice: Output "A) Option" or "1) Option" format - ONLY the choice, no explanation.
For math: Output ONLY the final answer in simplest form.
NO explanations. NO reasoning. NO additional text whatsoever.
Output the answer ONLY.`;

    let response, data, answer;
    const supportsVisionMessages = provider === "openai" || provider === "openrouter";
    const canUseImage = Boolean(imageDataUrl) && (provider === "gemini" || supportsVisionMessages);
    const effectiveImageDataUrl = canUseImage ? imageDataUrl : null;

    if (provider === "gemini") {
      // Gemini API format - endpoint includes model name
      const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      const parts = [];

      if (effectiveImageDataUrl) {
        // Extract base64 data from data URL
        const base64Data = effectiveImageDataUrl.split(',')[1];
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

      if (effectiveImageDataUrl) {
        // Vision API format with image
        messages.push({
          role: "user",
          content: [
            { type: "text", text: text },
            {
              type: "image_url",
              image_url: {
                url: effectiveImageDataUrl
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
          max_tokens: effectiveImageDataUrl ? 150 : 50,
          temperature: 0.1
        })
      });

      data = await response.json();

      if (data.error) {
        throw new Error(data.error.message);
      }

      answer = data.choices[0].message.content.trim();
    }

    // Post-process answer to extract just the choice if model returned too much text
    // Take first line if multiple lines, or first sentence if very long
    const lines = answer.split('\n');
    const firstLine = lines[0].trim();
    if (firstLine.length < 200 && !firstLine.toLowerCase().includes('explanation')) {
      answer = firstLine;
    } else if (firstLine.length >= 200) {
      // If still too long, try to extract just the choice (pattern like "A) text" or "1) text")
      const choiceMatch = answer.match(/^[A-Z0-9]+[.)\s]+[^.!?\n]{1,150}/i);
      if (choiceMatch) {
        answer = choiceMatch[0].trim();
      }
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
