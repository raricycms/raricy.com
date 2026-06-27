// ============================================================
//  ATÅMAS — Startup Bridge
//  Ensures all modules are loaded, then boots the game.
//  Load order: i18n.js → core.js → main.js
// ============================================================
(function() {

var I18n = window.AtamasI18n;
var Core = window.AtamasCore;

// ------ Boot Sequence ------

Core.loadSavedMode();
I18n.loadSavedLanguage();
I18n.initLanguageDropdown();
I18n.updateLanguageDisplay();
I18n.updateAllUI();
Core.initGame();
Core.animationLoop();

})();
