RL LIVE TRACKER
===============

START:  Start menu > RL Tracker  (or the desktop icon)
        - the tracker starts in the background and opens in your browser.
STOP:   Start menu > Stop RL Tracker
        (closing the browser tab does not stop it - it keeps recording)

WINDOWS SMARTSCREEN (when you ran the installer):
 The installer is not code-signed, so Windows may show a blue box saying
 "Windows protected your PC". That is Windows' standard warning for ANY
 unsigned download - it is not a virus verdict. "More info" > "Run anyway".
 Windows remembers your choice - you will not be asked again.

FIRST RUN (3 things):
 1. The game's stats feed: the tracker sets it up by itself. If the
    board shows a yellow message about restarting Rocket League,
    restart the game.
 2. Click YOUR OWN name in the player list during your first match -
    that is how the coach knows who you are.
 3. The tracker asks once: "Join the test round?" - yes means your
    match reports (readable JSON/HTML in data\, never keys) are
    sent to the developer. No = nothing is EVER uploaded.

THE FOLDER:
 RLTracker.exe   start (this is what the Start menu shortcut runs)
 data\           YOUR data: matches, reports, profile, settings, log
 app\            the tracker itself (board, coach engine, rank emblems)
 tools\          board for a second screen, overlay on/off, feedback export
 docs\           documentation - for you and for your AI

 Your data stays in data\ on this PC, and an update never touches it.
 Nothing is uploaded unless you said yes to the test round - and you can
 read every file that gets sent (data\matches\ and data\reports\).

UPDATING:
 Run the new RL-Tracker-Setup.exe on top of this one - it replaces app\
 and keeps data\. The board tells you when a new version is out.

RANK BADGES / LEGAL:
 Portions of the materials used are trademarks and/or copyrighted works
 of Epic Games, Inc. All rights reserved by Epic. This material is not
 official and is not endorsed by Epic.
 The rank emblems in app\ranks\ are Rocket League's own artwork, used
 under the Epic Games Fan Content Policy (free, non-commercial tool). The
 image files come from the open-source BakkesMod plugin RocketStats (MIT,
 github.com/Lyliya/RocketStats) - see app\ranks\CREDITS.txt.

DANSK: Start-menu > RL Tracker - trackeren starter i baggrunden og aabner
selv i din browser; Start-menu > Stop RL Tracker lukker den igen.
SmartScreen ved installationen: "Flere oplysninger" og saa "Koer alligevel"
- kun een gang. Foerste kamp: klik dit eget navn i spillerlisten. Du
spoerges EEN gang om testrunden: ja = dine kamprapporter (laesbar JSON/HTML
i data\) sendes til udvikleren; nej = der uploades aldrig noget. Dine data
ligger i data\ og roeres aldrig af en opdatering. Dokumentation: docs\.
