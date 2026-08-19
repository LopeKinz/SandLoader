/* eslint-env browser */
'use strict'
/**
 * SandLoader UI string catalogues.
 *
 * Sets `global.__SMLN_LOCALES__ = { en: {...}, de: {...} }` before i18n.js
 * runs, the same way prelude.js's own inline snippet sets `__SMLN_ENUMS__`
 * ahead of runtime.js - a data table has to exist before the code that reads
 * it does, and prepending is the only ordering guarantee this bundle offers.
 *
 * Each locale is a FLAT map of dotted keys to strings, not a nested object
 * tree. That keeps i18n.js's lookup a single property read (`table[key]`)
 * with no path-walking, and keeps this file a plain, diffable list rather
 * than a tree that merge conflicts badly.
 *
 * Pluralisation: where the English wording changes with count ("mod" vs
 * "mods"), the key is split into `<key>.one` and `<key>.other` and i18n.js
 * picks between them from `params.count`. Strings that do not change with
 * count (e.g. "{count} installed") stay a single key - splitting those would
 * just be two identical templates to keep in sync.
 *
 * `__meta` is not a translation - it is asked for directly by
 * `SMLN.i18n.locales()` to build a language picker, so it lives alongside the
 * strings rather than in a second table that could drift out of sync with
 * which locales actually exist here.
 *
 * German is written as the game's own dialogs would: informal register (du),
 * no machine-literal calques.
 *
 * Mod-supplied text - a mod's own name, id or description - is never looked
 * up here and never should be: those strings belong to the mod author, and
 * "translating" someone else's product name would misrepresent it. Only
 * SandLoader's own UI chrome is catalogued in this file.
 */
;(function installSmlnLocales(global) {
  if (global.__SMLN_LOCALES__) return // idempotent, like every other renderer part.

  var en = {
    __meta: { code: 'en', nativeName: 'English', englishName: 'English' },

    // ---------------------------------------------------------- mods.* (mod manager panel)
    'mods.title': 'SandLoader Mods',
    'mods.count': '{count} installed',
    'mods.installFromZip': 'Install from ZIP',
    'mods.openFolder': 'Open folder',
    'mods.close': 'Close',
    'mods.delete': 'Delete',
    'mods.sure': 'Sure?',
    'mods.empty': 'No mods installed. Use "Install from ZIP", or drop a mod folder into the mods directory.',
    'mods.chooseZip': 'choose a .zip archive ...',
    'mods.installing': 'Installing...',
    'mods.installFailed': 'install failed: {error}',
    'mods.installedStatus': 'installed {id}@{version}  -  restart the game to load it',
    'mods.replacedStatus': 'replaced {id}@{version}  -  restart the game to load it',
    'mods.opening': 'Opening...',
    'mods.openFolderFailed': 'could not open the folder: {error}',
    'mods.removing': 'Removing...',
    'mods.removeFailed': 'could not remove {id}: {error}',
    'mods.removedStatus': 'removed {id}  -  restart the game to unload it',
    'mods.confirmDeleteNote': 'click again to delete {id} from disk',
    'mods.changesNote': 'Changes apply the next time you start the game.',
    'mods.restartNote': 'Mods load at startup; toggling takes effect after a restart.',
    'mods.enabled': 'Enabled',
    'mods.disabled': 'Disabled',
    'mods.pendingRestart': '(restart to load)',
    'mods.tagFluxloader': 'Fluxloader',
    'mods.tagSandloader': 'SandLoader',
    'mods.unknownError': 'unknown error',

    // ---------------------------------------------------------- splash.* (loader splash screen)
    'splash.version': 'mod loader v{version}',
    'splash.preparing': 'preparing',
    'splash.noMods': 'no mods installed',
    'splash.loadedMods.one': 'loaded {count} mod',
    'splash.loadedMods.other': 'loaded {count} mods',
    'splash.loadedFluxMods.one': 'loaded {count} fluxloader mod',
    'splash.loadedFluxMods.other': 'loaded {count} fluxloader mods',

    // ---------------------------------------------------------- settings.* (per-mod settings panel)
    'settings.title': 'Settings',
    'settings.reset': 'Reset',
    'settings.resetAll': 'Reset all',
    'settings.save': 'Save',
    'settings.invalidValue': 'invalid value',
    'settings.restartRequired': 'restart required',
    'settings.noSettings': 'no settings',
    'settings.rangeError': 'value must be between {min} and {max}',
    'settings.integerError': 'must be a whole number',
    'settings.enumError': 'must be one of: {values}',

    // ---------------------------------------------------------- reload.* (hot mod reload)
    'reload.title': 'Reload Mods',
    'reload.reloading': 'Reloading…',
    'reload.reloaded.one': 'Reloaded {count} mod',
    'reload.reloaded.other': 'Reloaded {count} mods',
    'reload.failed': 'Reload failed: {error}',
    'reload.confirmRestart': 'This will restart the current session and unsaved progress will be lost. Continue?',
    'reload.watching': 'Watching for changes',
    'reload.changeDetected': 'changes detected in {mod}',

    // ---------------------------------------------------------- perm.* (permission review + badges)
    'perm.filesystem.title': 'Filesystem access',
    'perm.filesystem.desc': 'Lets this mod read and write files through SMLN.storage/SMLN.fs, scoped to its own mod data.',
    'perm.network.title': 'Network access',
    'perm.network.desc': 'Lets this mod contact remote servers through SMLN.net.',
    'perm.node.title': 'Node.js / native code',
    'perm.node.desc': 'Runs in the Electron main process with real Node.js: require, process, filesystem and network are all directly available. SandLoader does not sandbox this - it is exactly as privileged as the game itself.',
    'perm.game.title': 'Game integration',
    'perm.game.desc': "Runs inside the game itself and can read and change game state through SandLoader's API while you play.",
    'perm.worker.title': 'Simulation worker access',
    'perm.worker.desc': 'Runs inside the simulation worker and can affect how the world is simulated directly.',

    'perm.badge.sandboxed': 'SANDBOXED',
    'perm.badge.elevated': 'ELEVATED',
    'perm.badge.network': 'NETWORK',
    'perm.badge.filesystem': 'FILESYSTEM',
    'perm.badge.native': 'NATIVE',

    'perm.installTitle': 'Install "{name}"?',
    'perm.requests': 'This mod requests:',
    'perm.cancel': 'Cancel',
    'perm.install': 'Install',
    'perm.allowed': 'Allowed',
    'perm.notRequested': 'Not requested',
    'perm.permissions': 'Permissions',
    'perm.change': 'Permission Change',
    'perm.updateRequests': 'This update requests a new permission:',
    'perm.nativeWarning': 'Warning: this mod requests native Node.js access. Native mods can execute code with the same operating-system privileges as Sandustry and SandLoader. Only install this mod if you trust its author.',

    // ---------------------------------------------------------- lang.* (language picker)
    'lang.title': 'Language',
    'lang.systemDefault': 'System default',
    'lang.en': 'English',
    'lang.de': 'Deutsch',

    // ---------------------------------------------------------- common.* (shared chrome)
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.ok': 'OK',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.error': 'Error',
    'common.warning': 'Warning',
    'common.restartRequired': 'Restart required',

    // ------------------------------------------- added: review, problems, reload
    'perm.new': 'new',
    'perm.approve': 'Approve',
    'perm.revoke': 'Revoke approval',
    'perm.approvedAt': 'You approved this mod on {at}.',

    // ------------------------------------------- approval state (details panel)
    'perm.notApprovedYet': 'Not approved. This mod does not load until you approve it.',
    'perm.nothingToApprove': 'Nothing to approve — this mod requests no privileged capability.',
    'perm.approvedNow': 'Approved. It loads on the next reload.',
    'perm.revoked': 'Approval withdrawn. It stops loading on the next reload.',
    'perm.approveFailed': 'Could not save the approval: {error}',
    'perm.revokeFailed': 'Could not withdraw the approval: {error}',
    'perm.classifiedBecause': 'Classified this way because:',
    'perm.legacyNative': 'This mod predates SandLoader permissions and runs privileged main-process code. Treat it as a native mod.',
    'perm.notEnforceable': 'SandLoader cannot restrict what a native mod does. It runs with a real Node.js require, so filesystem and network limits do not apply to it.',

    // ---------------------------------------------------------- problems.*
    'problems.title': 'Problems',
    'problems.none': 'No problems. Every mod loaded cleanly.',
    'problems.summary': '{errors} error(s), {warnings} warning(s). Mods that failed were skipped; the rest loaded normally.',
    'problems.repeated': 'x{count}',
    'problems.forMod': 'Problems from this mod ({count})',
    'problems.button': 'Problems',
    'problems.badge': '{count} problem(s)',

    // ------------------------------------------------- settings.* (additions)
    'settings.reloadNotice': 'Some changes take effect after a reload.',
    'settings.loadFailed': 'Could not load settings: {error}',

    // --------------------------------------------------- reload.* (additions)
    'reload.action': 'Reload',
    'reload.needsRestart': 'A main-process entrypoint changed. Restart Sandustry to load it.',

    // --------------------------------------------------- mods.* (additions)
    'mods.settings': 'Settings',
    'mods.details': 'Details',
    'mods.reloadMods': 'Reload Mods',
    'mods.failed': 'failed to load',
    'mods.notApproved': 'needs approval',
    'mods.language': 'Language',

    // -------------------------------------------------- common.* (additions)
    'common.unknownError': 'unknown error',

    // ------------------------------------------------ splash.* (boot report)
    'splash.noReport': 'no boot report from the loader',
    'splash.versionDrift': 'game version differs from the verified build; hooks anchor on source strings',
    'splash.hooks': 'hooks',
    'splash.hooksTotal.one': '{count} hook',
    'splash.hooksTotal.other': '{count} hooks',
    'splash.rendererScripts': 'renderer mod scripts',
    'splash.workerScripts': 'worker mod scripts',
    'splash.assets': 'mod asset folders',
    'splash.captured': 'game API captured',
    'splash.modsActive.one': '{count} mod active',
    'splash.modsActive.other': '{count} mods active',
    'splash.errors.one': '{count} error',
    'splash.errors.other': '{count} errors',
    'splash.warnings.one': '{count} warning',
    'splash.warnings.other': '{count} warnings',
    'splash.allClear': 'all clear',
    'splash.moreProblems.one': '{count} more problem - see SandLoader Mods > Problems',
    'splash.moreProblems.other': '{count} more problems - see SandLoader Mods > Problems',
    'mods.stateDisabled': 'disabled',

    // ------------------------------------------------- mods.* (manager, cont.)
    'mods.choosingZip': 'choose a .zip archive ...',
    'mods.installCancelled': 'install cancelled',
    'mods.openFailed': 'could not open the folder: {error}',
    'mods.removed': 'removed {id}  -  reload to unload it',
    'mods.confirmDelete': 'click again to delete {id} from disk',
    'mods.pending': '(reload to load)',
    'mods.changesPending': 'Changes apply on the next reload.',
    'mods.hint': 'Mods load at startup; use Reload Mods to apply changes now.',
    'mods.brokenCount.one': '{count} failed',
    'mods.brokenCount.other': '{count} failed',

    // ------------------------------------------------------- Steam Workshop
    'mods.source.workshop': 'Workshop',
    'mods.source.local': 'Local',
    'mods.openInSteam': 'View in Steam',
    'mods.browseWorkshop': 'Browse Workshop',
    'mods.workshopManaged': 'Managed by Steam. Disable it here, or unsubscribe in Steam to remove it.',
    'mods.workshopUpdated': 'Steam last updated this on {at}.',
    'mods.workshopOpenFailed': 'Could not open Steam: {error}',
  }

  var de = {
    __meta: { code: 'de', nativeName: 'Deutsch', englishName: 'German' },

    // ---------------------------------------------------------- mods.*
    'mods.title': 'SandLoader-Mods',
    'mods.count': '{count} installiert',
    'mods.installFromZip': 'Aus ZIP installieren',
    'mods.openFolder': 'Ordner öffnen',
    'mods.close': 'Schließen',
    'mods.delete': 'Löschen',
    'mods.sure': 'Sicher?',
    'mods.empty': 'Keine Mods installiert. Nutze "Aus ZIP installieren" oder leg einen Mod-Ordner direkt in das Mods-Verzeichnis.',
    'mods.chooseZip': 'ZIP-Archiv auswählen ...',
    'mods.installing': 'Installiere ...',
    'mods.installFailed': 'Installation fehlgeschlagen: {error}',
    'mods.installedStatus': 'installiert: {id}@{version}  -  Spiel neu starten, um sie zu laden',
    'mods.replacedStatus': 'ersetzt: {id}@{version}  -  Spiel neu starten, um sie zu laden',
    'mods.opening': 'Öffne ...',
    'mods.openFolderFailed': 'Ordner konnte nicht geöffnet werden: {error}',
    'mods.removing': 'Entferne ...',
    'mods.removeFailed': '{id} konnte nicht entfernt werden: {error}',
    'mods.removedStatus': 'entfernt: {id}  -  Spiel neu starten, damit es entladen wird',
    'mods.confirmDeleteNote': 'noch einmal klicken, um {id} endgültig zu löschen',
    'mods.changesNote': 'Änderungen wirken erst beim nächsten Spielstart.',
    'mods.restartNote': 'Mods werden beim Start geladen; ein Umschalten wirkt erst nach einem Neustart.',
    'mods.enabled': 'Aktiviert',
    'mods.disabled': 'Deaktiviert',
    'mods.pendingRestart': '(Neustart nötig)',
    'mods.tagFluxloader': 'Fluxloader',
    'mods.tagSandloader': 'SandLoader',
    'mods.unknownError': 'unbekannter Fehler',

    // ---------------------------------------------------------- splash.*
    'splash.version': 'Mod-Loader v{version}',
    'splash.preparing': 'wird vorbereitet',
    'splash.noMods': 'keine Mods installiert',
    'splash.loadedMods.one': '{count} Mod geladen',
    'splash.loadedMods.other': '{count} Mods geladen',
    'splash.loadedFluxMods.one': '{count} Fluxloader-Mod geladen',
    'splash.loadedFluxMods.other': '{count} Fluxloader-Mods geladen',

    // ---------------------------------------------------------- settings.*
    'settings.title': 'Einstellungen',
    'settings.reset': 'Zurücksetzen',
    'settings.resetAll': 'Alles zurücksetzen',
    'settings.save': 'Speichern',
    'settings.invalidValue': 'ungültiger Wert',
    'settings.restartRequired': 'Neustart erforderlich',
    'settings.noSettings': 'keine Einstellungen',
    'settings.rangeError': 'Wert muss zwischen {min} und {max} liegen',
    'settings.integerError': 'muss eine ganze Zahl sein',
    'settings.enumError': 'muss einer der folgenden Werte sein: {values}',

    // ---------------------------------------------------------- reload.*
    'reload.title': 'Mods neu laden',
    'reload.reloading': 'Lädt neu …',
    'reload.reloaded.one': '{count} Mod neu geladen',
    'reload.reloaded.other': '{count} Mods neu geladen',
    'reload.failed': 'Neu laden fehlgeschlagen: {error}',
    'reload.confirmRestart': 'Dadurch wird die laufende Sitzung neu gestartet und nicht gespeicherter Fortschritt geht verloren. Fortfahren?',
    'reload.watching': 'Änderungen werden überwacht',
    'reload.changeDetected': 'Änderungen erkannt in {mod}',

    // ---------------------------------------------------------- perm.*
    'perm.filesystem.title': 'Dateisystemzugriff',
    'perm.filesystem.desc': 'Erlaubt diesem Mod, über SMLN.storage/SMLN.fs Dateien zu lesen und zu schreiben - beschränkt auf seine eigenen Mod-Daten.',
    'perm.network.title': 'Netzwerkzugriff',
    'perm.network.desc': 'Erlaubt diesem Mod, über SMLN.net mit entfernten Servern zu kommunizieren.',
    'perm.node.title': 'Node.js / nativer Code',
    'perm.node.desc': 'Läuft im Electron-Hauptprozess mit echtem Node.js: require, process, Dateisystem und Netzwerk stehen uneingeschränkt zur Verfügung. SandLoader schränkt das nicht ein - der Mod ist genauso privilegiert wie das Spiel selbst.',
    'perm.game.title': 'Spielintegration',
    'perm.game.desc': 'Läuft im Spiel selbst und kann über die SandLoader-API während des Spielens den Spielzustand lesen und verändern.',
    'perm.worker.title': 'Zugriff auf den Simulations-Worker',
    'perm.worker.desc': 'Läuft im Simulations-Worker und kann die Weltsimulation direkt beeinflussen.',

    'perm.badge.sandboxed': 'SANDBOX',
    'perm.badge.elevated': 'ERWEITERT',
    'perm.badge.network': 'NETZWERK',
    'perm.badge.filesystem': 'DATEISYSTEM',
    'perm.badge.native': 'NATIV',

    'perm.installTitle': '"{name}" installieren?',
    'perm.requests': 'Dieser Mod fordert an:',
    'perm.cancel': 'Abbrechen',
    'perm.install': 'Installieren',
    'perm.allowed': 'Erlaubt',
    'perm.notRequested': 'Nicht angefordert',
    'perm.permissions': 'Berechtigungen',
    'perm.change': 'Berechtigungsänderung',
    'perm.updateRequests': 'Dieses Update fordert eine neue Berechtigung an:',
    'perm.nativeWarning': 'Achtung: Dieser Mod fordert nativen Node.js-Zugriff an. Native Mods können Code mit denselben Rechten wie Sandustry und SandLoader selbst ausführen. Installiere ihn nur, wenn du dem Autor vollständig vertraust.',

    // ---------------------------------------------------------- lang.*
    'lang.title': 'Sprache',
    'lang.systemDefault': 'Systemstandard',
    'lang.en': 'English',
    'lang.de': 'Deutsch',

    // ---------------------------------------------------------- common.*
    'common.cancel': 'Abbrechen',
    'common.close': 'Schließen',
    'common.ok': 'OK',
    'common.yes': 'Ja',
    'common.no': 'Nein',
    'common.error': 'Fehler',
    'common.warning': 'Warnung',
    'common.restartRequired': 'Neustart erforderlich',

    // ------------------------------------------- ergaenzt: Pruefung, Probleme, Reload
    'perm.new': 'neu',
    'perm.approve': 'Zulassen',
    'perm.revoke': 'Zulassung entziehen',
    'perm.approvedAt': 'Du hast diesen Mod am {at} zugelassen.',

    // --------------------------------------- Zulassungsstatus (Details-Panel)
    'perm.notApprovedYet': 'Nicht zugelassen. Dieser Mod wird erst geladen, wenn du ihn zulaesst.',
    'perm.nothingToApprove': 'Nichts zuzulassen — dieser Mod fordert keine privilegierte Faehigkeit an.',
    'perm.approvedNow': 'Zugelassen. Wird beim naechsten Neuladen geladen.',
    'perm.revoked': 'Zulassung entzogen. Wird beim naechsten Neuladen nicht mehr geladen.',
    'perm.approveFailed': 'Zulassung konnte nicht gespeichert werden: {error}',
    'perm.revokeFailed': 'Zulassung konnte nicht entzogen werden: {error}',
    'perm.classifiedBecause': 'Diese Einstufung ergibt sich aus:',
    'perm.legacyNative': 'Dieser Mod stammt aus der Zeit vor den SandLoader-Berechtigungen und fuehrt privilegierten Code im Hauptprozess aus. Behandle ihn wie einen nativen Mod.',
    'perm.notEnforceable': 'SandLoader kann einen nativen Mod nicht einschraenken. Er laeuft mit einem echten Node.js-require, deshalb greifen Datei- und Netzwerkgrenzen bei ihm nicht.',

    // ---------------------------------------------------------- problems.*
    'problems.title': 'Probleme',
    'problems.none': 'Keine Probleme. Alle Mods wurden sauber geladen.',
    'problems.summary': '{errors} Fehler, {warnings} Warnung(en). Fehlgeschlagene Mods wurden uebersprungen, alle anderen normal geladen.',
    'problems.repeated': 'x{count}',
    'problems.forMod': 'Probleme dieses Mods ({count})',
    'problems.button': 'Probleme',
    'problems.badge': '{count} Problem(e)',

    // ------------------------------------------------- settings.* (Ergaenzungen)
    'settings.reloadNotice': 'Einige Aenderungen wirken erst nach einem Reload.',
    'settings.loadFailed': 'Einstellungen konnten nicht geladen werden: {error}',

    // --------------------------------------------------- reload.* (Ergaenzungen)
    'reload.action': 'Neu laden',
    'reload.needsRestart': 'Ein Einstiegspunkt im Hauptprozess hat sich geaendert. Starte Sandustry neu, damit er geladen wird.',

    // --------------------------------------------------- mods.* (Ergaenzungen)
    'mods.settings': 'Einstellungen',
    'mods.details': 'Details',
    'mods.reloadMods': 'Mods neu laden',
    'mods.failed': 'konnte nicht geladen werden',
    'mods.notApproved': 'braucht Zulassung',
    'mods.language': 'Sprache',

    // -------------------------------------------------- common.* (Ergaenzungen)
    'common.unknownError': 'unbekannter Fehler',

    // ------------------------------------------------ splash.* (Startbericht)
    'splash.noReport': 'kein Startbericht vom Loader',
    'splash.versionDrift': 'Spielversion weicht vom geprueften Build ab; Hooks haengen an Quelltext-Strings',
    'splash.hooks': 'Hooks',
    'splash.hooksTotal.one': '{count} Hook',
    'splash.hooksTotal.other': '{count} Hooks',
    'splash.rendererScripts': 'Renderer-Mod-Skripte',
    'splash.workerScripts': 'Worker-Mod-Skripte',
    'splash.assets': 'Mod-Asset-Ordner',
    'splash.captured': 'Spiel-API uebernommen',
    'splash.modsActive.one': '{count} Mod aktiv',
    'splash.modsActive.other': '{count} Mods aktiv',
    'splash.errors.one': '{count} Fehler',
    'splash.errors.other': '{count} Fehler',
    'splash.warnings.one': '{count} Warnung',
    'splash.warnings.other': '{count} Warnungen',
    'splash.allClear': 'alles in Ordnung',
    'splash.moreProblems.one': '{count} weiteres Problem - siehe SandLoader-Mods > Probleme',
    'splash.moreProblems.other': '{count} weitere Probleme - siehe SandLoader-Mods > Probleme',
    'mods.stateDisabled': 'deaktiviert',

    // ------------------------------------------------- mods.* (Manager, Forts.)
    'mods.choosingZip': 'waehle ein .zip-Archiv ...',
    'mods.installCancelled': 'Installation abgebrochen',
    'mods.openFailed': 'Ordner konnte nicht geoeffnet werden: {error}',
    'mods.removed': '{id} entfernt  -  neu laden, um ihn zu entladen',
    'mods.confirmDelete': 'nochmal klicken, um {id} von der Platte zu loeschen',
    'mods.pending': '(neu laden zum Laden)',
    'mods.changesPending': 'Aenderungen greifen beim naechsten Neuladen.',
    'mods.hint': 'Mods werden beim Start geladen; nutze "Mods neu laden", um Aenderungen sofort zu uebernehmen.',
    'mods.brokenCount.one': '{count} fehlgeschlagen',
    'mods.brokenCount.other': '{count} fehlgeschlagen',

    // ------------------------------------------------------- Steam Workshop
    'mods.source.workshop': 'Workshop',
    'mods.source.local': 'Lokal',
    'mods.openInSteam': 'In Steam ansehen',
    'mods.browseWorkshop': 'Workshop durchsuchen',
    'mods.workshopManaged': 'Wird von Steam verwaltet. Hier deaktivieren, oder in Steam abbestellen zum Entfernen.',
    'mods.workshopUpdated': 'Steam hat das zuletzt am {at} aktualisiert.',
    'mods.workshopOpenFailed': 'Steam konnte nicht geoeffnet werden: {error}',
  }

  global.__SMLN_LOCALES__ = { en: en, de: de }
})(typeof globalThis !== 'undefined' ? globalThis : window)
