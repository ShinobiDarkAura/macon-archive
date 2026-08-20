Maçon Archive — drop-in assets
================================

  bell.mp3   — real cow/sheep-bell notification sound (now included; replaces the synth).

Choosing a bell
---------------
There are 5 options. The app plays bell.mp3 — to switch, just rename the one you
like to bell.mp3 (back up the old one first), e.g. `mv bell3.mp3 bell.mp3`.

  bell.mp3    clean single clank (current default)
  bell2.mp3   herd jingle A  (from Vaches cloches 01)
  bell3.mp3   herd jingle B  (from Vaches cloches 02)
  bell4.mp3   herd jingle C  (from Vaches cloches 03)
  bell5.mp3   a second, distinct single clank (from Vaches cloches 04)

All are ~1.6s, loudness-normalized and faded.

Sound credit
------------
All clips are trimmed/normalized from the "Vaches cloches" recordings by
Hicham-chahidi (Wikimedia Commons), licensed CC BY-SA 3.0.
Source: https://commons.wikimedia.org/wiki/File:Vaches_cloches_04.wav

Notes
-----
- Chat avatars now reuse the existing bundled images: pieces/rebi.avif (Hannah / rabbit)
  and pieces/ori.avif (Alex / bear). No upload needed — they were already in the repo.
- To swap which keeper is the rabbit vs the bear, edit the ANIMALS map in index.html.
- Until bell.mp3 exists, the notification uses the in-browser synth bell automatically.
