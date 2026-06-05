chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== chrome.runtime.OnInstalledReason.INSTALL) return;
  chrome.runtime.openOptionsPage(() => {
    void chrome.runtime.lastError;
  });
});
