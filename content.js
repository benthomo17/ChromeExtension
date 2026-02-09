
// Create popup container using Shadow DOM to isolate from page
let popupContainer = null;
let shadowRoot = null;
let popup = null;
let hideTimeout = null;

// Floating button variables
let buttonContainer = null;
let buttonShadowRoot = null;
let floatingButton = null;
let currentSelection = "";
let lastMouseX = 0;
let lastMouseY = 0;

function createPopup() {
  if (popupContainer) return;

  popupContainer = document.createElement("div");
  popupContainer.id = "ai-helper-container";
  // Use fixed positioning and reset properties
  popupContainer.style.cssText = "position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none; border: none; margin: 0; padding: 0;";

  shadowRoot = popupContainer.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    .ai-popup {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%) translateY(10px);
      background: #ffffff;
      color: #333;
      padding: 12px 18px;
      border-radius: 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 16px;
      font-weight: 500;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
      max-width: 300px;
      pointer-events: auto;
      opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s ease;
      border: 1px solid #e0e0e0;
      z-index: 2147483647;
    }
    .ai-popup.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .ai-popup.loading {
      color: #999;
    }
    .ai-popup.error {
      background: #fff5f5;
      border-color: #ffcccc;
      color: #cc0000;
    }
    .ai-popup .close-btn {
      position: absolute;
      top: 4px;
      right: 8px;
      background: none;
      border: none;
      color: #999;
      font-size: 14px;
      cursor: pointer;
      padding: 2px 6px;
    }
    .ai-popup .close-btn:hover {
      color: #333;
    }
    .ai-popup .answer {
      margin-top: 2px;
    }
  `;
  shadowRoot.appendChild(style);

  popup = document.createElement("div");
  popup.className = "ai-popup";
  popup.innerHTML = '<button class="close-btn">×</button><div class="answer"></div>';
  shadowRoot.appendChild(popup);

  popup.querySelector(".close-btn").addEventListener("click", hidePopup);

  // Append to body if available, otherwise documentElement
  (document.body || document.documentElement).appendChild(popupContainer);
}

function createFloatingButton() {
  if (buttonContainer) return;

  buttonContainer = document.createElement("div");
  buttonContainer.id = "ai-helper-button-container";
  // Use fixed positioning relative to viewport
  buttonContainer.style.cssText = "position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none; border: none; margin: 0; padding: 0; overflow: visible;";

  buttonShadowRoot = buttonContainer.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    .ai-btn {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #2196F3;
      color: white;
      border: none;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      cursor: pointer;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, opacity 0.2s, background 0.2s;
      opacity: 0;
      pointer-events: none;
      transform: scale(0.8);
      z-index: 2147483647;
    }
    .ai-btn.visible {
      opacity: 1;
      transform: scale(1);
      pointer-events: auto;
    }
    .ai-btn:hover {
      transform: scale(1.1);
      background: #1976D2;
    }
    .ai-btn svg {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }
    .ai-btn-tooltip {
      position: fixed;
      bottom: 70px;
      right: 20px;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 6px 10px;
      border-radius: 4px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s;
      z-index: 2147483647;
    }
    .ai-btn:hover + .ai-btn-tooltip,
    .ai-btn-tooltip.visible {
      opacity: 1;
    }
  `;
  buttonShadowRoot.appendChild(style);

  floatingButton = document.createElement("button");
  floatingButton.className = "ai-btn";
  floatingButton.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M12 2L14.39 9.61L22 12L14.39 14.39L12 22L9.61 14.39L2 12L9.61 9.61L12 2Z" />
    </svg>
  `;

  const tooltip = document.createElement("div");
  tooltip.className = "ai-btn-tooltip";
  tooltip.textContent = "Click: Analyze question + image";

  floatingButton.addEventListener("click", handleButtonClick, true);

  buttonShadowRoot.appendChild(floatingButton);
  buttonShadowRoot.appendChild(tooltip);

  // Append to body if available, otherwise documentElement
  (document.body || document.documentElement).appendChild(buttonContainer);
}

function updateButtonPosition() {
  const selection = window.getSelection();
  const text = selection.toString().trim();

  if (!text) {
    if (floatingButton) floatingButton.classList.remove("visible");
    return;
  }

  currentSelection = text;
  createFloatingButton();

  // Store selection in background immediately (like context menu capture)
  chrome.runtime.sendMessage({ action: "storeSelection", text: text });

  // Button is fixed position in bottom-right corner, just show it
  floatingButton.classList.add("visible");
}

async function handleButtonClick(e) {
  e.stopPropagation();
  e.preventDefault();

  try {
    // Copy selection to clipboard (this captures full selection like context menu)
    document.execCommand('copy');

    // Read it back from clipboard
    const text = await navigator.clipboard.readText();

    if (text && text.trim()) {
      // Always send selection with image capture for merged question + image analysis.
      chrome.runtime.sendMessage({ action: "analyzeWithImage", text: text.trim() });
    } else {
      chrome.runtime.sendMessage({ action: "collectAndAnalyze" });
    }
  } catch (err) {
    // Fallback to stored selection
    chrome.runtime.sendMessage({ action: "collectAndAnalyze" });
  }

  floatingButton.classList.remove("visible");
}

// Track mouse position for fallback positioning
document.addEventListener("mousemove", (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
}, true);

// Event Listeners - use capture phase to work on sites that stop propagation
document.addEventListener("mouseup", (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  // Small delay to ensure selection is finalized
  setTimeout(updateButtonPosition, 50);
}, true);  // capture phase

document.addEventListener("keyup", (e) => {
  if (e.key === "Shift" || e.key.startsWith("Arrow")) {
    setTimeout(updateButtonPosition, 50);
  }
}, true);  // capture phase

// Also listen on selectionchange as a fallback for sites that block mouseup
document.addEventListener("selectionchange", () => {
  setTimeout(updateButtonPosition, 100);
});

// Hide on scroll (with debounce to avoid hiding during small movements)
let scrollTimeout = null;
document.addEventListener("scroll", () => {
  if (floatingButton && floatingButton.classList.contains("visible")) {
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      // Re-check if selection still exists, if so reposition instead of hiding
      const selection = window.getSelection();
      if (selection.toString().trim()) {
        updateButtonPosition();
      } else {
        floatingButton.classList.remove("visible");
      }
    }, 150);
  }
}, { passive: true });

// Also hide on click elsewhere if selection is cleared
document.addEventListener("mousedown", (e) => {
  // If clicking outside the button, we might want to hide it
  // But let the selection change handle it (mouseup will fire later)
  // If user clicks to clear selection, mouseup will see empty selection and hide it.
});

// Existing Popup Logic
function showPopup(content, isLoading = false, isError = false) {
  createPopup();

  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  popup.className = "ai-popup";
  if (isLoading) popup.classList.add("loading");
  if (isError) popup.classList.add("error");

  popup.querySelector(".answer").textContent = content;

  // Force reflow then show
  popup.offsetHeight;
  popup.classList.add("visible");

  if (!isLoading) {
    hideTimeout = setTimeout(hidePopup, 8000);
  }
}

function hidePopup() {
  if (popup) {
    popup.classList.remove("visible");
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "showPopup") {
    // Only show popup in top frame to avoid duplicates
    if (window === window.top) {
      showPopup(request.content, request.loading, request.error);
    }
    return false;
  } else if (request.action === "getSelection") {
    sendResponse({ text: window.getSelection().toString() });
    return false;
  }
});
