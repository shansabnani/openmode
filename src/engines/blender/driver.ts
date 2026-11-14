/**
 * The Python that runs inside Blender. openmode writes it to the job folder
 * and starts Blender with `--python driver.py -- job.json`.
 *
 * It applies the job (frame range, size, renderer, samples), renders one PNG
 * per frame with sequential names, and reports what it did in result.json.
 * Anything that stops the render is written to error.json in plain words.
 */
export const DRIVER_PY = String.raw`
import json, os, runpy, sys, traceback

import bpy

job_path = sys.argv[sys.argv.index("--") + 1]
with open(job_path, "r", encoding="utf-8") as handle:
    job = json.load(handle)
job_dir = os.path.dirname(job_path)


def stop(message):
    with open(os.path.join(job_dir, "error.json"), "w", encoding="utf-8") as handle:
        json.dump({"message": message}, handle)
    sys.exit(1)


def set_renderer(scene, name):
    choices = {
        "cycles": ["CYCLES"],
        "eevee": ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"],
        "workbench": ["BLENDER_WORKBENCH"],
    }[name]
    for choice in choices:
        try:
            scene.render.engine = choice
            return
        except TypeError:
            continue
    stop("This Blender does not have the " + name + " renderer.")


def get_samples(scene):
    engine = scene.render.engine
    if engine == "CYCLES":
        return scene.cycles.samples
    if engine.startswith("BLENDER_EEVEE"):
        return scene.eevee.taa_render_samples
    return None


def set_samples(scene, samples):
    engine = scene.render.engine
    if engine == "CYCLES":
        scene.cycles.samples = samples
    elif engine.startswith("BLENDER_EEVEE"):
        scene.eevee.taa_render_samples = samples


def even(value):
    return max(2, int(round(value / 2.0)) * 2)


try:
    script = job.get("script")
    if script:
        os.chdir(os.path.dirname(script))
        try:
            runpy.run_path(script, run_name="__main__")
        except SystemExit:
            pass
        except Exception:
            lines = traceback.format_exc().strip().splitlines()
            stop("The scene script failed: " + lines[-1] + " (" + " | ".join(lines[-4:-1]) + ")")

    scene = bpy.context.scene
    if scene.camera is None:
        cameras = [item for item in scene.objects if item.type == "CAMERA"]
        if not cameras:
            stop("The scene has no camera. Add a camera, or set scene.camera, then render again.")
        scene.camera = cameras[0]

    if job.get("renderer"):
        set_renderer(scene, job["renderer"])

    start = job.get("start") or scene.frame_start
    end = job.get("end") or scene.frame_end
    if end < start:
        stop("The frame range ends (" + str(end) + ") before it starts (" + str(start) + ").")
    step = job.get("step") or 1
    max_frames = job.get("maxFrames")
    auto_step = False
    if max_frames and not job.get("step"):
        total = end - start + 1
        if total > max_frames:
            step = -(-total // max_frames)
            auto_step = True
    numbers = list(range(start, end + 1, step))

    render = scene.render
    width = render.resolution_x * render.resolution_percentage / 100.0
    height = render.resolution_y * render.resolution_percentage / 100.0
    short_side = job.get("shortSide")
    if short_side and short_side < min(width, height):
        scale = short_side / min(width, height)
        width, height = width * scale, height * scale
    render.resolution_x = even(width)
    render.resolution_y = even(height)
    render.resolution_percentage = 100

    samples = get_samples(scene)
    if job.get("samples"):
        samples = job["samples"]
        set_samples(scene, samples)
    elif job.get("maxSamples") and samples and samples > job["maxSamples"]:
        samples = job["maxSamples"]
        set_samples(scene, samples)

    settings = render.image_settings
    if hasattr(settings, "media_type"):
        settings.media_type = "IMAGE"
    settings.file_format = "PNG"
    settings.color_mode = "RGB"
    render.use_file_extension = True
    render.use_overwrite = True

    frames_dir = os.path.join(job_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    for index, number in enumerate(numbers):
        scene.frame_set(number)
        render.filepath = os.path.join(frames_dir, "frame_%05d" % (index + 1))
        bpy.ops.render.render(write_still=True)
        print("OPENMODE %d/%d" % (index + 1, len(numbers)), flush=True)

    with open(os.path.join(job_dir, "result.json"), "w", encoding="utf-8") as handle:
        json.dump(
            {
                "count": len(numbers),
                "start": start,
                "end": end,
                "step": step,
                "autoStep": auto_step,
                "fps": render.fps / render.fps_base,
                "width": render.resolution_x,
                "height": render.resolution_y,
                "renderer": scene.render.engine,
                "samples": samples,
            },
            handle,
        )
except SystemExit:
    raise
except Exception:
    lines = traceback.format_exc().strip().splitlines()
    stop("Blender could not render the scene: " + lines[-1])
`;
