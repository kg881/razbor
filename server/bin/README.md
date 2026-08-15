`ffmpeg` здесь — симлинк на статический бинарь из пакета `imageio-ffmpeg`
(brew в системе нет). Восстановить:

    python3 -m pip install --user imageio-ffmpeg
    ln -sf "$(python3 -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')" server/bin/ffmpeg

Путь переопределяется переменной `FFMPEG_PATH`.
Для `yt-dlp -g` нужен JS-рантайм: `curl -fsSL https://deno.land/install.sh | sh`.
