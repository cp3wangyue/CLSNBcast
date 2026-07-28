import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import sanitizeHtml from 'sanitize-html';
import {
  DatabaseService,
  NoticeRecord,
  NoticeTargetPage,
  NoticeWriteInput,
} from '../database/database.service';
import { WriteNoticeDto } from './notices.dto';

const TARGET_ORDER: NoticeTargetPage[] = ['server_admin', 'share', 'view'];

@Injectable()
export class NoticesService {
  constructor(private readonly db: DatabaseService) {}

  listPublic(page: NoticeTargetPage): NoticeRecord[] {
    return this.db.listNotices(page, false);
  }

  listAdmin(): NoticeRecord[] {
    return this.db.listNotices(undefined, true);
  }

  create(dto: WriteNoticeDto): NoticeRecord {
    return this.db.createNotice(randomUUID(), this.normalize(dto));
  }

  update(id: string, dto: WriteNoticeDto): NoticeRecord {
    const current = this.db.getNotice(id);
    if (!current) throw new BadRequestException('通知不存在');
    const normalized = this.normalize(dto);
    const bumpRevision = this.shouldBumpRevision(current, normalized);
    return this.db.updateNotice(id, normalized, bumpRevision)!;
  }

  delete(id: string): boolean {
    return this.db.deleteNotice(id);
  }

  reorder(ids: string[]): void {
    const existing = this.db.listNotices(undefined, true);
    const existingIds = new Set(existing.map(notice => notice.id));
    if (ids.length !== existingIds.size || ids.some(id => !existingIds.has(id))) {
      throw new BadRequestException('排序列表必须包含全部通知且不能重复');
    }
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('排序列表不能包含重复通知');
    }
    this.db.reorderNotices(ids);
  }

  republish(id: string): NoticeRecord {
    const notice = this.db.republishNotice(id);
    if (!notice) throw new BadRequestException('通知不存在');
    return notice;
  }

  private normalize(dto: WriteNoticeDto): NoticeWriteInput {
    const title = (dto.title || '').trim();
    const imageUrl = this.normalizeImageUrl(dto.imageUrl || '');
    const content = dto.contentFormat === 'html'
      ? this.sanitizeRichHtml(dto.content)
      : dto.content.trim();
    if (!content && !imageUrl) {
      throw new BadRequestException('通知正文和图片不能同时为空');
    }
    if (dto.kind === 'modal' && !dto.modalPolicy) {
      throw new BadRequestException('强提醒必须选择关闭策略');
    }

    const targets = [...new Set(dto.targets)]
      .sort((a, b) => TARGET_ORDER.indexOf(a) - TARGET_ORDER.indexOf(b));

    return {
      kind: dto.kind,
      modalPolicy: dto.kind === 'modal' ? dto.modalPolicy! : null,
      title,
      contentFormat: dto.contentFormat,
      content,
      imageUrl,
      enabled: dto.enabled,
      sortOrder: dto.sortOrder,
      repeatAfterSec: dto.repeatAfterSec ?? null,
      targets,
    };
  }

  private normalizeImageUrl(raw: string): string {
    const value = raw.trim();
    if (!value) return '';
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('图片地址格式不正确');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadRequestException('图片地址只允许 HTTP 或 HTTPS');
    }
    return url.toString();
  }

  private sanitizeRichHtml(value: string): string {
    return sanitizeHtml(value, {
      allowedTags: [
        'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
        'h1', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'li',
        'a', 'img', 'code', 'pre', 'span',
      ],
      allowedAttributes: {
        a: ['href', 'title', 'target'],
        img: ['src', 'alt', 'title', 'width', 'height'],
        span: ['class'],
      },
      allowedClasses: {
        span: ['notice-highlight', 'notice-muted'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
      allowedSchemesByTag: {
        img: ['http', 'https'],
      },
      transformTags: {
        a: sanitizeHtml.simpleTransform('a', {
          rel: 'noopener noreferrer',
        }),
      },
      disallowedTagsMode: 'discard',
      enforceHtmlBoundary: true,
    }).trim();
  }

  private shouldBumpRevision(
    current: NoticeRecord,
    next: NoticeWriteInput,
  ): boolean {
    const currentTargets = [...current.targets].sort().join(',');
    const nextTargets = [...next.targets].sort().join(',');
    return (
      current.kind !== next.kind ||
      current.modalPolicy !== next.modalPolicy ||
      current.title !== (next.title || '') ||
      current.contentFormat !== next.contentFormat ||
      current.content !== next.content ||
      current.imageUrl !== (next.imageUrl || '') ||
      currentTargets !== nextTargets ||
      (!current.enabled && next.enabled)
    );
  }
}
