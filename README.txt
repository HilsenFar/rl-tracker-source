RL LIVE TRACKER
===============

START:  Double-click  RLTrackerServer.exe
        - the tracker opens in your browser by itself.
        (Start-RL-Tracker.bat does the same and can be made a shortcut.)

WINDOWS SMARTSCREEN (first launch):
 The exe is not code-signed, so Windows may show a blue box saying
 "Windows protected your PC" with "RLTrackerServer.exe" named as an
 unrecognised app. That is Windows' standard warning for ANY unsigned
 download - it is not a virus verdict. To run the tracker:
   1. Click "More info"   (the small link under the text)
   2. Click "Run anyway"  (the button that appears)
 Windows remembers your choice - you will not be asked again.

FIRST RUN (3 things):
 1. The game's stats feed: the tracker sets it up by itself. If the
    board shows a yellow message about restarting Rocket League,
    restart the game.
 2. Click YOUR OWN name in the player list during your first match -
    that is how the coach knows who you are.
 3. The tracker asks once: "Join the test round?" - yes means your
    match reports (readable JSON/HTML in this folder, never keys) are
    sent to the developer. No = nothing is EVER uploaded.

THE FOLDER:
 vaerktoejer\   board for a second screen, overlay, desktop shortcut,
                feedback export ("vaerktoejer" is Danish for "tools")
 docs\          documentation - for you and for your AI
 director\      the coach engine (leave it alone)

 Your data (matches, reports, profile) stays in THIS folder. Nothing is
 uploaded unless you said yes to the test round - and you can read every
 file that gets sent (matches\ and reports\).

DANSK: Dobbeltklik paa RLTrackerServer.exe - trackeren aabner selv i din
browser. SmartScreen: klik "Flere oplysninger" og saa "Koer alligevel" -
kun een gang. Foerste kamp: klik dit eget navn i spillerlisten. Du
spoerges EEN gang om testrunden: ja = dine kamprapporter (laesbar
JSON/HTML i denne mappe) sendes til udvikleren; nej = der uploades
aldrig noget. Dokumentation: docs\.
