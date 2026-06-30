let toastContainer = null;

function ensureToastContainer() {
  if (toastContainer) {
    return toastContainer;
  }

  toastContainer = document.getElementById("toastContainer");

  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.id = "toastContainer";
    toastContainer.className = "toast-container";
    toastContainer.setAttribute("aria-live", "polite");
    document.body.appendChild(toastContainer);
  }

  return toastContainer;
}

export function showToast(message, type = "success", duration = 4500) {
  if (!message) return;

  const container = ensureToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast-item toast-${type === "error" ? "error" : "success"}`;
  toast.textContent = message;
  container.appendChild(toast);

  console.log(`[toast] ${type}:`, message);

  setTimeout(() => {
    toast.classList.add("toast-hide");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
