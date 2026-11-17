/**
 * Type declarations for packages without bundled or DefinitelyTyped types.
 */

declare module "ffmpeg-static" {
  const path: string | null;
  export default path;
}

declare module "prism-media" {
  import { Transform, TransformOptions } from "stream";

  interface OpusDecoderOptions {
    rate: number;
    channels: number;
    frameSize: number;
  }

  interface OpusEncoderOptions {
    rate: number;
    channels: number;
    frameSize: number;
  }

  namespace opus {
    class Decoder extends Transform {
      constructor(options: OpusDecoderOptions);
    }
    class Encoder extends Transform {
      constructor(options: OpusEncoderOptions);
    }
  }

  namespace FFmpeg {
    class FFmpeg extends Transform {
      constructor(options?: { args?: string[] });
    }
  }

  const prism: {
    opus: typeof opus;
    FFmpeg: typeof FFmpeg.FFmpeg;
  };

  export default prism;
}
