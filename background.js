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

function normalizeAnswerContent(content) {
  if (content == null) return "";

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .join("")
      .trim();
  }

  if (typeof content === "object" && typeof content.text === "string") {
    return content.text.trim();
  }

  return "";
}

function extractGeminiAnswer(data) {
  console.log("[AI Extension] Gemini raw response:", JSON.stringify(data));

  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts;
  const answer = Array.isArray(parts)
    ? parts.map((part) => part?.text || "").join("").trim()
    : "";

  if (!answer) {
    const finishReason = candidate?.finishReason;
    const blockReason = data?.promptFeedback?.blockReason;
    if (finishReason === "MAX_TOKENS") {
      throw new Error("Response cut off (MAX_TOKENS). Raise the token cap or use a non-reasoning model.");
    }
    if (finishReason === "SAFETY" || finishReason === "RECITATION" || blockReason) {
      throw new Error(`Blocked by Gemini safety filter (${blockReason || finishReason}). The aggressive system prompt may be triggering it.`);
    }
    throw new Error(`Empty Gemini response${finishReason ? ` (${finishReason})` : ""}. Check service worker console for raw data.`);
  }

  return answer;
}

function extractChatAnswer(data) {
  console.log("[AI Extension] Chat raw response:", JSON.stringify(data));

  // OpenRouter sometimes returns 200 OK with an error object in the body
  if (data?.error) {
    const errMsg = typeof data.error === "string" ? data.error : (data.error.message || JSON.stringify(data.error));
    throw new Error(`Provider error: ${errMsg}`);
  }

  if (!Array.isArray(data?.choices) || data.choices.length === 0) {
    throw new Error("Provider returned no choices. The upstream model may be unavailable — try a different model.");
  }

  const choice = data.choices[0];
  const message = choice?.message;

  // Try every place a model might have stashed the answer:
  // - message.content: standard
  // - message.reasoning / reasoning_content: DeepSeek-R1, Kimi K2, o1-style reasoning models on OpenRouter
  // - message.refusal: OpenAI structured refusal field
  // - choice.text: legacy completion format
  const rawContent =
    message?.content
    || message?.reasoning_content
    || message?.reasoning
    || choice?.text
    || message?.refusal;
  const answer = normalizeAnswerContent(rawContent);

  if (!answer) {
    const finishReason = choice?.finish_reason || choice?.native_finish_reason;
    if (message?.refusal) {
      throw new Error(`Model refused: ${message.refusal}`);
    }
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
      throw new Error("Model returned a tool call instead of text.");
    }
    if (finishReason === "length") {
      throw new Error("Response cut off (length). Raise the token cap or use a non-reasoning model.");
    }
    if (finishReason === "content_filter") {
      throw new Error("Response blocked by content filter — try a different model or rephrase.");
    }
    const keys = message ? Object.keys(message).join(",") : "no message";
    throw new Error(`Empty answer${finishReason ? ` (${finishReason})` : ""}. message fields: [${keys}]. Check service worker console.`);
  }

  return answer;
}

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

      data = await response.json().catch(() => null);

      if (!response.ok) {
        const errMsg = data?.error?.message || `HTTP ${response.status} ${response.statusText}`;
        throw new Error(errMsg);
      }
      if (data?.error) {
        throw new Error(typeof data.error === "string" ? data.error : (data.error.message || JSON.stringify(data.error)));
      }

      answer = extractGeminiAnswer(data);
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

      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      };
      if (provider === "openrouter") {
        // OpenRouter routes by these headers; some upstreams reject without them.
        headers["HTTP-Referer"] = "https://chrome-extension/ai-quick-answer";
        headers["X-Title"] = "AI Quick Answer Extension";
      }

      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model,
          messages: messages,
          max_tokens: effectiveImageDataUrl ? 1024 : 512,
          temperature: 0.1
        })
      });

      data = await response.json().catch(() => null);

      if (!response.ok) {
        const errMsg = data?.error?.message || `HTTP ${response.status} ${response.statusText}`;
        throw new Error(errMsg);
      }

      answer = extractChatAnswer(data);
    }

    // Post-process: take first non-empty line if short, else try to pull out a choice pattern.
    const firstLine = answer.split('\n').map(l => l.trim()).find(l => l.length > 0) || answer.trim();
    if (firstLine && firstLine.length < 200 && !firstLine.toLowerCase().includes('explanation')) {
      answer = firstLine;
    } else if (firstLine.length >= 200) {
      const choiceMatch = answer.match(/[A-Z0-9]+[.)\s]+[^.!?\n]{1,150}/i);
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
