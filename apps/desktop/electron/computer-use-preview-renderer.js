for (const name of ["pause", "hide", "stop"]) document.getElementById(name).addEventListener("click", () => window.computerPreview.action(name));
window.computerPreview.onState((value) => {
  document.getElementById("app").textContent = value.appName;
  document.getElementById("status").textContent = value.phase === "paused" ? value.status : value.mode === "observe" ? "Read only · no mouse or keyboard access" : "Keep this app in front. Your input pauses control.";
  document.getElementById("time").textContent = Math.ceil(value.remainingSeconds / 60) + " min";
  document.getElementById("pause").hidden = value.mode === "observe" || value.phase === "paused";
});
window.computerPreview.onImage((value) => { document.getElementById("preview").src = value; });
