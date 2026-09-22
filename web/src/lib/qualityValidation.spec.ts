import { describe, expect, it } from 'vitest';
import { hasRejection, validateCustomQuality } from './qualityValidation';
import type { QualityLimits } from '../types';

const limits: QualityLimits = {
  width: { min: 16, max: 4096, step: 2 },
  height: { min: 16, max: 2160, step: 2 },
  frameRate: { min: 1, max: 120, recommendedMin: 5, recommendedMax: 60 },
  bitrate: { min: 1, max: 30000, recommendedMin: 100, recommendedMax: 5000 },
  maxPixels: 3840 * 2160,
};

const valid = { width: 1920, height: 1080, frameRate: 30, bitrateMin: 2000, bitrateMax: 4000 };

describe('validateCustomQuality（前端镜像）', () => {
  it('标准参数无问题', () => {
    expect(validateCustomQuality(valid, limits)).toEqual([]);
  });

  it('码率留空合法', () => {
    expect(hasRejection(validateCustomQuality(
      { width: 1280, height: 720, frameRate: 30 }, limits,
    ))).toBe(false);
  });

  it('🔑 超出建议码率只 warn，不拦截（不修改用户输入）', () => {
    const issues = validateCustomQuality(
      { ...valid, bitrateMin: 10, bitrateMax: 20000 }, limits,
    );

    expect(hasRejection(issues)).toBe(false);
    expect(issues.filter((i) => i.severity === 'warn').length).toBeGreaterThan(0);
  });

  it('4K@60 这类高吞吐配置只 warn', () => {
    const issues = validateCustomQuality({ width: 3840, height: 2160, frameRate: 60 }, limits);

    expect(hasRejection(issues)).toBe(false);
    expect(issues.some((i) => i.code === 'HIGH_PIXEL_RATE')).toBe(true);
  });

  const rejectCases: [string, Record<string, unknown>, string][] = [
    ['宽度非整数', { ...valid, width: 1920.5 }, 'NOT_INTEGER'],
    ['宽度非正数', { ...valid, width: 0 }, 'NOT_POSITIVE'],
    ['帧率为 0', { ...valid, frameRate: 0 }, 'NOT_POSITIVE'],
    ['宽度为奇数', { ...valid, width: 1921 }, 'ODD_DIMENSION'],
    ['高度为奇数', { ...valid, height: 1081 }, 'ODD_DIMENSION'],
    ['宽度超上限', { ...valid, width: 99999 }, 'OUT_OF_RANGE'],
    ['帧率超上限', { ...valid, frameRate: 500 }, 'OUT_OF_RANGE'],
    ['像素数超限', { width: 7680, height: 4320, frameRate: 30 }, 'PIXELS_TOO_LARGE'],
    ['bitrateMin 非正数', { ...valid, bitrateMin: 0 }, 'NOT_POSITIVE'],
    ['max 低于 min', { ...valid, bitrateMin: 5000, bitrateMax: 1000 }, 'MAX_BELOW_MIN'],
  ];

  for (const [label, input, expectedCode] of rejectCases) {
    it(`拒绝：${label}`, () => {
      const issues = validateCustomQuality(input as any, limits);
      expect(hasRejection(issues)).toBe(true);
      expect(issues.some((i) => i.code === expectedCode)).toBe(true);
    });
  }

  it('🔒 服务端未下发边界时不误杀合法输入（向后兼容旧后端）', () => {
    expect(hasRejection(validateCustomQuality(valid, undefined))).toBe(false);
  });

  it('未下发边界时仍然拒绝奇数和非法关系', () => {
    expect(hasRejection(validateCustomQuality({ ...valid, width: 1921 }, undefined))).toBe(true);
    expect(hasRejection(validateCustomQuality(
      { ...valid, bitrateMin: 5000, bitrateMax: 1000 }, undefined,
    ))).toBe(true);
  });
});

describe('hasRejection', () => {
  it('无问题 / 只有 warn 时为 false', () => {
    expect(hasRejection([])).toBe(false);
    expect(hasRejection([{ field: 'f', severity: 'warn', code: 'c', message: 'm' }])).toBe(false);
  });

  it('有 reject 时为 true', () => {
    expect(hasRejection([{ field: 'f', severity: 'reject', code: 'c', message: 'm' }])).toBe(true);
  });
});
