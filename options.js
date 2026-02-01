const PROVIDERS = {
  gemini: {
    name: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    apiKeyHint: 'Get your API key from <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>',
    models: [
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash (recommended)" },
      { id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }
    ]
  },
  groq: {
    name: "Groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    apiKeyHint: 'Get your API key from <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a>',
    models: [
      { id: "moonshotai/kimi-k2-instruct", name: "Kimi K2 (recommended)" },
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B (fast)" },
      { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B" },
      { id: "gemma2-9b-it", name: "Gemma 2 9B" }
    ]
  },
  openai: {
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKeyHint: 'Get your API key from <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>',
    models: [
      { id: "gpt-4o-mini", name: "GPT-4o Mini (recommended)" },
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
      { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo (fast)" }
    ]
  },
  custom: {
    name: "Custom",
    endpoint: "",
    apiKeyHint: "Enter your API key for the custom provider",
    models: []
  }
};

const providerSelect = document.getElementById("provider");
const modelSelect = document.getElementById("model");
const modelHint = document.getElementById("modelHint");
const apiKeyInput = document.getElementById("apiKey");
const apiKeyHint = document.getElementById("apiKeyHint");
const customFields = document.getElementById("customFields");
const customEndpoint = document.getElementById("customEndpoint");
const customModel = document.getElementById("customModel");
const saveBtn = document.getElementById("save");
const status = document.getElementById("status");

function updateUI(provider) {
  const config = PROVIDERS[provider];

  // Update API key hint
  apiKeyHint.innerHTML = config.apiKeyHint;

  // Update model dropdown
  modelSelect.innerHTML = "";
  if (config.models.length > 0) {
    config.models.forEach(model => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name;
      modelSelect.appendChild(option);
    });
    modelSelect.parentElement.style.display = "block";
  } else {
    modelSelect.parentElement.style.display = "none";
  }

  // Show/hide custom fields
  if (provider === "custom") {
    customFields.classList.add("visible");
  } else {
    customFields.classList.remove("visible");
  }
}

// Load saved settings
document.addEventListener("DOMContentLoaded", async () => {
  const settings = await chrome.storage.sync.get([
    "provider", "model", "apiKey", "customEndpoint", "customModel"
  ]);

  if (settings.provider) {
    providerSelect.value = settings.provider;
  }

  updateUI(providerSelect.value);

  if (settings.model) {
    modelSelect.value = settings.model;
  }
  if (settings.apiKey) {
    apiKeyInput.value = settings.apiKey;
  }
  if (settings.customEndpoint) {
    customEndpoint.value = settings.customEndpoint;
  }
  if (settings.customModel) {
    customModel.value = settings.customModel;
  }
});

// Handle provider change
providerSelect.addEventListener("change", () => {
  updateUI(providerSelect.value);
});

// Save settings
saveBtn.addEventListener("click", async () => {
  const provider = providerSelect.value;
  const model = modelSelect.value;
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    status.textContent = "Please enter an API key";
    status.className = "status error";
    return;
  }

  if (provider === "custom") {
    if (!customEndpoint.value.trim() || !customModel.value.trim()) {
      status.textContent = "Please enter custom endpoint and model";
      status.className = "status error";
      return;
    }
  }

  await chrome.storage.sync.set({
    provider,
    model,
    apiKey,
    customEndpoint: customEndpoint.value.trim(),
    customModel: customModel.value.trim()
  });

  status.textContent = "Settings saved!";
  status.className = "status success";
  setTimeout(() => {
    status.className = "status";
  }, 2000);
});
