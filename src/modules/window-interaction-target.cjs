// Authorize the owning window, independently of whether it has a project yet.
function interactionTarget(sender, characters, bubbles) {
  const character = characters.getActiveWindow();
  if (!character || character.isDestroyed()) return null;
  if (character.webContents === sender) return { window: character, projectId: characters.getProjectIdByWebContents(sender) };
  for (const [projectId, window] of bubbles.bubbleWindows) {
    if (!window.isDestroyed() && window.webContents === sender && characters.getWindow(projectId) === character) {
      return { window, projectId };
    }
  }
  return null;
}
module.exports = { interactionTarget };
