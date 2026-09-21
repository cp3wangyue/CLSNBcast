import { QualityLimits } from './quality-config.types';
import {
  CustomQualityInput,
  QualityCodec,
  QualityIssue,
  QualityOptimizationMode,
} from './quality-preset.types';

const OPTIMIZATION_MODES: QualityOptimizationMode[] = ['motion', 'detail'];
const CODECS: QualityCodec[] = ['h264', 'vp8', 'vp9'];

/**
 * 校验自定义画质参数。
 *
 * 分两档，这是自由画质的核心取舍：
 * - **结构性错误 → reject**：类型/正数/min-max 关系/硬边界。这类参数传给 SDK 必定失败或产生废流。
 * - **超出声网建议范围 → warn**：只提示，**不强制修改用户输入**。用户可能就是要用 4K@60
 *   或超高码率，那是他的带宽与他的钱。
 */
export function validateCustomQuality(
  input: CustomQualityInput,
  limits: QualityLimits,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const reject = (field: string, code: string, message: string) =>
    issues.push({ field, severity: 'reject', code, message });
  const warn = (field: string, code: string, message: string) =>
    issues.push({ field, severity: 'warn', code, message });

  for (const field of ['width', 'height', 'frameRate'] as const) {
    const value = input[field];
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      reject(field, 'NOT_INTEGER', `${field} 必须是整数`);
    } else if (value <= 0) {
      reject(field, 'NOT_POSITIVE', `${field} 必须为正数`);
    }
  }

  const w = input.width;
  const h = input.height;
  const fps = input.frameRate;

  // 偶数：H.264 要求宽高为偶数，奇数会让编码器失败
  if (Number.isInteger(w) && w > 0 && w % 2 !== 0) {
    reject('width', 'ODD_DIMENSION', '宽度必须为偶数（H.264 要求）');
  }
  if (Number.isInteger(h) && h > 0 && h % 2 !== 0) {
    reject('height', 'ODD_DIMENSION', '高度必须为偶数（H.264 要求）');
  }

  if (w > limits.width.max || w < limits.width.min) {
    reject('width', 'OUT_OF_RANGE', `宽度需在 ${limits.width.min}~${limits.width.max} 之间`);
  }
  if (h > limits.height.max || h < limits.height.min) {
    reject('height', 'OUT_OF_RANGE', `高度需在 ${limits.height.min}~${limits.height.max} 之间`);
  }
  if (fps > limits.frameRate.max || fps < limits.frameRate.min) {
    reject(
      'frameRate',
      'OUT_OF_RANGE',
      `帧率需在 ${limits.frameRate.min}~${limits.frameRate.max} 之间`,
    );
  }

  if (Number.isFinite(w) && Number.isFinite(h) && w * h > limits.maxPixels) {
    reject(
      'width,height',
      'PIXELS_TOO_LARGE',
      `分辨率 ${w}×${h} 超过上限 ${limits.maxPixels} 像素`,
    );
  }

  const { bitrateMin, bitrateMax } = input;
  for (const [field, value] of [['bitrateMin', bitrateMin], ['bitrateMax', bitrateMax]] as const) {
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      reject(field, 'NOT_POSITIVE', `${field} 必须为正数或留空`);
    }
  }

  if (
    bitrateMin !== null && bitrateMin !== undefined &&
    bitrateMax !== null && bitrateMax !== undefined &&
    Number.isFinite(bitrateMin) && Number.isFinite(bitrateMax) &&
    bitrateMax < bitrateMin
  ) {
    reject('bitrateMax', 'MAX_BELOW_MIN', '最高码率不能低于最低码率');
  }

  if (input.optimizationMode && !OPTIMIZATION_MODES.includes(input.optimizationMode)) {
    reject(
      'optimizationMode',
      'INVALID_MODE',
      `optimizationMode 只能是 ${OPTIMIZATION_MODES.join(' 或 ')}`,
    );
  }
  if (input.codec && !CODECS.includes(input.codec)) {
    reject('codec', 'INVALID_CODEC', `codec 只能是 ${CODECS.join(' / ')}`);
  }

  // ===== 以下是「仅提示」=====

  for (const [field, value] of [['bitrateMin', bitrateMin], ['bitrateMax', bitrateMax]] as const) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    if (value < limits.bitrate.recommendedMin || value > limits.bitrate.recommendedMax) {
      warn(
        field,
        'OUTSIDE_RECOMMENDED',
        `${field} = ${value} Kbps，超出声网建议范围 ` +
          `${limits.bitrate.recommendedMin}~${limits.bitrate.recommendedMax} Kbps，` +
          '实际码率可能被 SDK 或浏览器调整',
      );
    }
  }

  if (Number.isFinite(fps) && (fps < limits.frameRate.recommendedMin || fps > limits.frameRate.recommendedMax)) {
    warn(
      'frameRate',
      'OUTSIDE_RECOMMENDED',
      `帧率 ${fps} fps 超出建议范围 ${limits.frameRate.recommendedMin}~${limits.frameRate.recommendedMax} fps`,
    );
  }

  // 像素吞吐率明显高于建议：例如 4K@60
  if (
    Number.isFinite(w) && Number.isFinite(h) && Number.isFinite(fps) &&
    w > 0 && h > 0 && fps > 0 &&
    w * h * fps > 1920 * 1080 * 60
  ) {
    warn(
      'width,height,frameRate',
      'HIGH_PIXEL_RATE',
      `${w}×${h}@${fps}fps 的像素吞吐率很高，可能需要较强的上行带宽与硬件编码能力`,
    );
  }

  return issues;
}

/** 是否应拒绝（存在 severity='reject' 的问题）。 */
export function hasRejection(issues: QualityIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'reject');
}
