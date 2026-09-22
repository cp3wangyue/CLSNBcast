import type { CustomQualityInput, QualityIssue, QualityLimits } from '../types';

/**
 * 前端镜像的画质校验。
 *
 * 与服务端 `quality-validation.ts` 保持同一套规则与文案，目的是**即时反馈**，
 * 服务端仍会再校验一次 —— 前端校验只是体验优化，不是安全边界。
 *
 * 两档语义与服务端一致：
 * - `reject`：结构性错误，必须修正才能开始；
 * - `warn`：超出声网建议范围，**只提示，不修改用户输入**。
 */
export function validateCustomQuality(
  input: CustomQualityInput,
  limits?: QualityLimits,
): QualityIssue[] {
  // 服务端未下发边界时（旧版本后端）只做最基本的类型与正数检查，
  // 避免因为缺配置就把用户的合法输入判死。
  const lim = limits ?? {
    width: { min: 1, max: 8192, step: 2 },
    height: { min: 1, max: 8192, step: 2 },
    frameRate: { min: 1, max: 240, recommendedMin: 5, recommendedMax: 60 },
    bitrate: { min: 1, max: 30000, recommendedMin: 100, recommendedMax: 5000 },
    maxPixels: 3840 * 2160,
  };

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

  const { width: w, height: h, frameRate: fps } = input;

  if (Number.isInteger(w) && w > 0 && w % 2 !== 0) {
    reject('width', 'ODD_DIMENSION', '宽度必须为偶数（H.264 要求）');
  }
  if (Number.isInteger(h) && h > 0 && h % 2 !== 0) {
    reject('height', 'ODD_DIMENSION', '高度必须为偶数（H.264 要求）');
  }

  if (w > lim.width.max || w < lim.width.min) {
    reject('width', 'OUT_OF_RANGE', `宽度需在 ${lim.width.min}~${lim.width.max} 之间`);
  }
  if (h > lim.height.max || h < lim.height.min) {
    reject('height', 'OUT_OF_RANGE', `高度需在 ${lim.height.min}~${lim.height.max} 之间`);
  }
  if (fps > lim.frameRate.max || fps < lim.frameRate.min) {
    reject('frameRate', 'OUT_OF_RANGE', `帧率需在 ${lim.frameRate.min}~${lim.frameRate.max} 之间`);
  }
  if (Number.isFinite(w) && Number.isFinite(h) && w * h > lim.maxPixels) {
    reject('width,height', 'PIXELS_TOO_LARGE', `分辨率 ${w}×${h} 超过上限 ${lim.maxPixels} 像素`);
  }

  const { bitrateMin, bitrateMax } = input;
  for (const [field, value] of [['bitrateMin', bitrateMin], ['bitrateMax', bitrateMax]] as const) {
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      reject(field, 'NOT_POSITIVE', `${field} 必须为正数或留空`);
    }
  }
  if (
    bitrateMin != null && bitrateMax != null &&
    Number.isFinite(bitrateMin) && Number.isFinite(bitrateMax) &&
    bitrateMax < bitrateMin
  ) {
    reject('bitrateMax', 'MAX_BELOW_MIN', '最高码率不能低于最低码率');
  }

  // ===== 仅提示 =====
  for (const [field, value] of [['bitrateMin', bitrateMin], ['bitrateMax', bitrateMax]] as const) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    if (value < lim.bitrate.recommendedMin || value > lim.bitrate.recommendedMax) {
      warn(
        field,
        'OUTSIDE_RECOMMENDED',
        `${field} = ${value} Kbps，超出声网建议范围 ` +
          `${lim.bitrate.recommendedMin}~${lim.bitrate.recommendedMax} Kbps，` +
          '实际码率可能被 SDK 或浏览器调整',
      );
    }
  }
  if (Number.isFinite(fps) && (fps < lim.frameRate.recommendedMin || fps > lim.frameRate.recommendedMax)) {
    warn(
      'frameRate',
      'OUTSIDE_RECOMMENDED',
      `帧率 ${fps} fps 超出建议范围 ${lim.frameRate.recommendedMin}~${lim.frameRate.recommendedMax} fps`,
    );
  }
  if (
    Number.isFinite(w) && Number.isFinite(h) && Number.isFinite(fps) &&
    w > 0 && h > 0 && fps > 0 && w * h * fps > 1920 * 1080 * 60
  ) {
    warn(
      'width,height,frameRate',
      'HIGH_PIXEL_RATE',
      `${w}×${h}@${fps}fps 的像素吞吐率很高，可能需要较强的上行带宽与硬件编码能力`,
    );
  }

  return issues;
}

export function hasRejection(issues: QualityIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'reject');
}
