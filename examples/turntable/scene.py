# A turntable: a cube and a ball on a floor, with the camera circling them once.
# Render it with:  npx -y openmode render scene.py --draft
import math

import bpy

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = color
    return mat


bpy.ops.mesh.primitive_plane_add(size=40)
bpy.context.object.data.materials.append(material("floor", (0.9, 0.88, 0.8, 1)))
bpy.ops.mesh.primitive_cube_add(size=1.6, location=(-1.2, 0, 0.8))
bpy.context.object.data.materials.append(material("cube", (1.0, 0.77, 0.0, 1)))
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.9, location=(1.3, 0.4, 0.9))
bpy.ops.object.shade_smooth()
bpy.context.object.data.materials.append(material("ball", (0.05, 0.05, 0.05, 1)))

bpy.ops.object.light_add(type="SUN", location=(4, -4, 8))
bpy.context.object.data.energy = 4
bpy.context.object.rotation_euler = (math.radians(50), 0, math.radians(35))

# The camera hangs off an empty at the centre; turning the empty circles the camera.
bpy.ops.object.empty_add(location=(0, 0, 0.8))
pivot = bpy.context.object
bpy.ops.object.camera_add(location=(0, -11, 4.5))
camera = bpy.context.object
camera.parent = pivot
camera.constraints.new("TRACK_TO").target = pivot
scene.camera = camera

scene.frame_start, scene.frame_end = 1, 72
scene.render.fps = 24
scene.render.resolution_x, scene.render.resolution_y = 1280, 720

# Linear keys, and a last key one frame past the end, so the turn loops cleanly.
bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
pivot.keyframe_insert("rotation_euler", frame=1)
pivot.rotation_euler = (0, 0, math.radians(360))
pivot.keyframe_insert("rotation_euler", frame=73)

scene.world = bpy.data.worlds.new("sky")
scene.world.color = (0.75, 0.82, 0.9)
