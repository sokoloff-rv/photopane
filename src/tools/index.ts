import { Tool } from './tool';
import { BrushTool, EraserTool } from './brush';
import { MarqueeTool, LassoTool, FreeLassoTool, WandTool } from './select';
import { MoveTool, HandTool, EyedropperTool, BucketTool, GradientTool, SoonTool } from './basic';
import { CropTool, PerspCropTool } from './crop';
import { TextTool } from './text';
import { ShapeTool } from './shape';

/** All tools in toolbar order. */
export function createTools(): Tool[] {
  return [
    new MoveTool(),
    new MarqueeTool(),
    new FreeLassoTool(),
    new LassoTool(),
    new WandTool(),
    new CropTool(),
    new PerspCropTool(),
    new EyedropperTool(),
    new SoonTool('heal', 'heal', 'J'),
    new BrushTool(),
    new SoonTool('replace', 'replace', 'B'),
    new SoonTool('stamp', 'stamp', 'S'),
    new EraserTool(),
    new GradientTool(),
    new BucketTool(),
    new SoonTool('blur', 'blur', 'R'),
    new SoonTool('sharpen', 'sharpen', 'R'),
    new SoonTool('smudge', 'smudge', 'R'),
    new SoonTool('dodge', 'dodge', 'O'),
    new SoonTool('burn', 'burn', 'O'),
    new TextTool(),
    new ShapeTool(),
    new HandTool(),
  ];
}
