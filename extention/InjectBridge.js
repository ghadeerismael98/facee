// Inject script into the webpage context
const script = document.createElement("script");
script.textContent = `
  window.sendToExtension = function(userInfo) {
    window.postMessage({ type: 'FROM_PAGE', userInfo: userInfo }, '*');
  };
`;
document.documentElement.appendChild(script);
script.remove();

// Listen to messages from the page
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data.type && event.data.type === "FROM_PAGE") {
    chrome.runtime.sendMessage(
      {
        message: "loginSuccess",
        user: event.data.userInfo,
      },
      function (response) {
        console.log("Extension responded:", response);
      }
    );
  }
});
