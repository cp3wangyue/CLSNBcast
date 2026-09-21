import { describe, expect, it } from 'vitest';
import { DEFAULT_QUALITY_CONFIG } from './quality-config.types';
import { hasRejection, validateCustomQuality } from './quality-validation';

const limits = DEFAULT_QUALITY_CONFIG.limits;

const valid = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  bitrateMin: 2000,
  bitrateMax: 4000, // 在声网建议的 100~5000 Kbps 之内，因此不应产生 warn
};

describe('validateCustomQuality — 合法参数', () => {
  it('标准参数无问题', () => {
    expect(validateCustomQuality(valid, limits)).toEqual([]);
  });

  it('码率留空合法（由 SDK 与浏览器协商）', () => {
    const issues = validateCustomQuality(
      { width: 1280, height: 720, frameRate: 30 },
      limits,
    );
    expect(hasRejection(issues)).toBe(false);
    expect(issues.filter((i) => i.field === 'bitrateMin')).toEqual([]);
  });

  it('自定义分辨率 + 自定义帧率合法', () => {
    expect(hasRejection(validateCustomQuality(
      { width: 1600, height: 900, frameRate: 45, bitrateMin: 1500, bitrateMax: 4500 },
      limits,
    ))).toBe(false);
  });

  it('合法档位不产生 warn', () => {
    const issues = validateCustomQuality(
      { width: 1920, height: 1080, frameRate: 30, bitrateMin: 2000, bitrateMax: 4000 },
      limits,
    );
    expect(issues).toEqual([]);
  });
});

describe('validateCustomQuality — 必须拒绝', () => {
  const rejectCases: [string, Record<string, unknown>, string][] = [
    ['宽度非整数', { ...valid, width: 1920.5 }, 'NOT_INTEGER'],
    ['宽度非正数', { ...valid, width: 0 }, 'NOT_POSITIVE'],
    ['宽度为负', { ...valid, width: -1920 }, 'NOT_POSITIVE'],
    ['高度为 NaN', { ...valid, height: Number.NaN }, 'NOT_INTEGER'],
    ['帧率为 0', { ...valid, frameRate: 0 }, 'NOT_POSITIVE'],
    ['宽度为奇数', { ...valid, width: 1921 }, 'ODD_DIMENSION'],
    ['高度为奇数', { ...valid, height: 1081 }, 'ODD_DIMENSION'],
    ['宽度超上限', { ...valid, width: 99999 }, 'OUT_OF_RANGE'],
    ['高度低于下限', { ...valid, height: 2 }, 'OUT_OF_RANGE'],
    ['帧率超上限', { ...valid, frameRate: 500 }, 'OUT_OF_RANGE'],
    ['像素数超限', { width: 7680, height: 4320, frameRate: 30 }, 'PIXELS_TOO_LARGE'],
    ['bitrateMin 非正数', { ...valid, bitrateMin: 0 }, 'NOT_POSITIVE'],
    ['bitrateMax 非正数', { ...valid, bitrateMax: -5 }, 'NOT_POSITIVE'],
    ['max 低于 min', { ...valid, bitrateMin: 5000, bitrateMax: 1000 }, 'MAX_BELOW_MIN'],
    ['optimizationMode 非法', { ...valid, optimizationMode: 'balanced' }, 'INVALID_MODE'],
    ['codec 非法', { ...valid, codec: 'av9' }, 'INVALID_CODEC'],
  ];

  for (const [label, input, expectedCode] of rejectCases) {
    it(`拒绝：${label}`, () => {
      const issues = validateCustomQuality(input as any, limits);
      expect(hasRejection(issues)).toBe(true);
      expect(issues.some((i) => i.code === expectedCode)).toBe(true);
    });
  }

  it('reject 级问题的 severity 为 reject', () => {
    const issues = validateCustomQuality({ ...valid, width: 1921 }, limits);
    expect(issues.find((i) => i.code === 'ODD_DIMENSION')!.severity).toBe('reject');
  });
});

describe('validateCustomQuality — 仅提示（不拦截）', () => {
  it('🔑 超出声网建议码率范围只 warn，不修改用户输入', () => {
    const issues = validateCustomQuality(
      { ...valid, bitrateMin: 10, bitrateMax: 20000 },
      limits,
    );

    expect(hasRejection(issues)).toBe(false);
    const warnings = issues.filter((i) => i.severity === 'warn');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((w) => w.field.startsWith('bitrate'))).toBe(true);
  });

  it('超出建议帧率范围只 warn', () => {
    const issues = validateCustomQuality({ ...valid, frameRate: 90 }, limits);

    expect(hasRejection(issues)).toBe(false);
    expect(issues.some((i) => i.code === 'OUTSIDE_RECOMMENDED' && i.field === 'frameRate')).toBe(true);
  });

  it('4K@60 这类高吞吐配置只 warn', () => {
    const issues = validateCustomQuality(
      { width: 3840, height: 2160, frameRate: 60 },
      limits,
    );

    expect(hasRejection(issues)).toBe(false);
    expect(issues.some((i) => i.code === 'HIGH_PIXEL_RATE')).toBe(true);
  });

  it('🔑 混合场景：既有 reject 也有 warn 时，两者都返回', () => {
    const issues = validateCustomQuality(
      { width: 1921, height: 1080, frameRate: 90, bitrateMin: 2000 },
      limits,
    );

    expect(hasRejection(issues)).toBe(true);
    expect(issues.some((i) => i.severity === 'warn')).toBe(true);
  });
});

describe('hasRejection', () => {
  it('无问题时为 false', () => {
    expect(hasRejection([])).toBe(false);
  });

  it('只有 warn 时为 false', () => {
    expect(hasRejection([
      { field: 'f', severity: 'warn', code: 'c', message: 'm' },
    ])).toBe(false);
  });

  it('有 reject 时为 true', () => {
    expect(hasRejection([
      { field: 'f', severity: 'reject', code: 'c', message: 'm' },
    ])).toBe(true);
  });
});
