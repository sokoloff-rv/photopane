import { Tool } from './tool';
import { BrushTool, EraserTool } from './brush';
import { MarqueeTool, LassoTool, WandTool } from './select';
import { MoveTool, HandTool, EyedropperTool, BucketTool, GradientTool, SoonTool } from './basic';
import { CropTool, PerspCropTool } from './crop';
import { TextTool } from './text';
import { ShapeTool } from './shape';
import { BlurTool, SharpenTool, SmudgeTool, DodgeTool, BurnTool, ReplaceTool, StampTool } from './retouch';

/** All tools in toolbar order. */
export function createTools(): Tool[] {
  return [
    new MoveTool(),
    new MarqueeTool(),
    new LassoTool(),
    new WandTool(),
    new CropTool(),
    new PerspCropTool(),
    new EyedropperTool(),
    new SoonTool('heal', 'heal', 'J'),
    new BrushTool(),
    new ReplaceTool(),
    new StampTool(),
    new EraserTool(),
    new GradientTool(),
    new BucketTool(),
    new BlurTool(),
    new SharpenTool(),
    new SmudgeTool(),
    new DodgeTool(),
    new BurnTool(),
    new TextTool(),
    new ShapeTool(),
    new HandTool(),
  ];
}
