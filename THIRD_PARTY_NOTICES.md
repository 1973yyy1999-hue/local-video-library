# Third-party components

Application code is MIT licensed. This does not replace licenses of bundled components.

- Electron 45.0.0 — MIT, with Chromium and Node.js third-party notices distributed with Electron: https://github.com/electron/electron/tree/v45.0.0
- Fuse.js 7.5.0 — Apache-2.0: https://github.com/krisk/Fuse/tree/v7.5.0
- ffmpeg-static 5.3.0 — GPL-3.0-or-later; this package downloads an FFmpeg executable and publishes build/source information: https://github.com/eugeneware/ffmpeg-static
- ffprobe-static 3.1.0 — package wrapper MIT; the executable is separately governed by its FFmpeg build configuration and licenses: https://github.com/joshwnj/ffprobe-static

FFmpeg licensing and corresponding source/build information: https://ffmpeg.org/legal.html and https://ffmpeg.org/download.html . The package repositories above identify their binary origins. FFmpeg is invoked as a separate executable; libx264 is used for short preview encoding. Package license files are retained in the distributed node_modules/resources alongside their code. Electron's LICENSE and LICENSES.chromium.html accompany the desktop runtime.

PotPlayer is not bundled, modified, or redistributed. The app can hand a local file to the user's existing Windows default player or to a player executable explicitly selected by the user.


The Windows portable archive includes a `resources/third-party/` directory generated from the locked dependencies: package LICENSE/COPYING texts, FFmpeg and FFprobe `-version` and `-L` output, and a copy of this source-information document. The recorded binary versions and configure flags identify the actual shipped builds; the package repositories above provide their distribution/build origins. Obtain source for the recorded FFmpeg versions through https://ffmpeg.org/releases/ and the referenced binary publishers' build repositories. This app does not modify FFmpeg or FFprobe. Rebuilding a matching executable also requires the upstream build configuration and enabled libraries shown in the recorded output.
