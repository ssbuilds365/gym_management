import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { BehaviorSubject, Subject } from 'rxjs';
import { AuthService } from './auth';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const WARNING_BEFORE_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const REFRESH_BEFORE_MS = 24 * 60 * 60 * 1000;
const EVENT_THROTTLE_MS = 2 * 1000;

interface SessionMessage {
  sessionId: string;
  type: 'activity' | 'refresh';
  at?: number;
  expiresAt?: string;
}

@Injectable({ providedIn: 'root' })
export class SessionActivityService {
  readonly warning$ = new BehaviorSubject<boolean>(false);
  readonly remainingMs$ = new BehaviorSubject<number>(IDLE_TIMEOUT_MS);
  readonly sessionExpired$ = new Subject<'inactive' | 'revoked'>();

  private sessionId = '';
  private lastActivityAt = 0;
  private expiresAt = 0;
  private lastEventAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private channel?: BroadcastChannel;
  private readonly storageHandler = (event: StorageEvent) => this.onStorage(event);
  private readonly activityHandler = () => this.recordActivity();
  private expired = false;

  constructor(
    private readonly auth: AuthService,
    @Inject(DOCUMENT) private readonly document: Document
  ) {}

  start(session: { id: string; lastActivityAt: string; expiresAt: string }): void {
    if (this.sessionId === session.id && this.timer) return;
    this.stop();
    this.sessionId = session.id;
    this.expiresAt = Date.parse(session.expiresAt);
    const storedActivity = Number(localStorage.getItem(this.activityKey()) || 0);
    this.lastActivityAt = Math.max(Date.parse(session.lastActivityAt) || Date.now(), storedActivity);
    this.expired = false;
    this.document.addEventListener('pointerdown', this.activityHandler, { passive: true });
    this.document.addEventListener('keydown', this.activityHandler);
    this.document.addEventListener('touchstart', this.activityHandler, { passive: true });
    this.document.addEventListener('mousemove', this.activityHandler, { passive: true });
    window.addEventListener('storage', this.storageHandler);
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`ssfm-session-${this.sessionId}`);
      this.channel.onmessage = event => this.onMessage(event.data as SessionMessage);
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  recordActivity(): void {
    if (!this.sessionId || this.expired) return;
    const now = Date.now();
    if (now - this.lastEventAt < EVENT_THROTTLE_MS) return;
    this.lastEventAt = now;
    this.lastActivityAt = now;
    localStorage.setItem(this.activityKey(), String(now));
    this.channel?.postMessage({ sessionId: this.sessionId, type: 'activity', at: now } satisfies SessionMessage);
    this.warning$.next(false);
    this.tick();
    this.sendHeartbeatIfDue(now);
    this.refreshIfNeeded(now);
  }

  stayLoggedIn(): void {
    this.recordActivity();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.document.removeEventListener('pointerdown', this.activityHandler);
    this.document.removeEventListener('keydown', this.activityHandler);
    this.document.removeEventListener('touchstart', this.activityHandler);
    this.document.removeEventListener('mousemove', this.activityHandler);
    window.removeEventListener('storage', this.storageHandler);
    this.channel?.close();
    this.channel = undefined;
    this.sessionId = '';
    this.warning$.next(false);
  }

  private tick(): void {
    if (!this.sessionId || this.expired) return;
    const remaining = Math.max(0, this.lastActivityAt + IDLE_TIMEOUT_MS - Date.now());
    this.remainingMs$.next(remaining);
    this.warning$.next(remaining > 0 && remaining <= WARNING_BEFORE_MS);
    if (remaining === 0) this.expire('inactive');
  }

  private sendHeartbeatIfDue(now: number): void {
    const key = this.heartbeatKey();
    const lastHeartbeat = Number(localStorage.getItem(key) || 0);
    if (now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    localStorage.setItem(key, String(now));
    this.auth.recordActivity().subscribe({
      next: response => this.acceptSessionUpdate(response?.session?.expiresAt),
      error: error => this.handleSessionError(error)
    });
  }

  private refreshIfNeeded(now: number): void {
    if (!Number.isFinite(this.expiresAt) || this.expiresAt - now > REFRESH_BEFORE_MS) return;
    const key = this.refreshLockKey();
    const currentLock = Number(localStorage.getItem(key) || 0);
    if (currentLock > now) return;
    const lockUntil = now + 30_000;
    localStorage.setItem(key, String(lockUntil));
    this.auth.refreshSession().subscribe({
      next: response => {
        this.acceptSessionUpdate(response?.session?.expiresAt);
        localStorage.removeItem(key);
      },
      error: error => {
        localStorage.removeItem(key);
        this.handleSessionError(error);
      }
    });
  }

  private acceptSessionUpdate(expiresAt?: string): void {
    if (!expiresAt) return;
    this.expiresAt = Date.parse(expiresAt);
    this.channel?.postMessage({
      sessionId: this.sessionId,
      type: 'refresh',
      expiresAt
    } satisfies SessionMessage);
  }

  private handleSessionError(error: unknown): void {
    if (!(error instanceof HttpErrorResponse)) return;
    if (error.status === 409 && error.error?.code === 'SESSION_REFRESHED') {
      this.acceptSessionUpdate(error.error?.session?.expiresAt);
      return;
    }
    if (error.status === 401) {
      this.expire(error.error?.code === 'SESSION_EXPIRED' ? 'inactive' : 'revoked');
    }
  }

  private expire(reason: 'inactive' | 'revoked'): void {
    if (this.expired) return;
    this.expired = true;
    this.warning$.next(false);
    this.auth.logout().subscribe({ error: () => undefined });
    this.sessionExpired$.next(reason);
    this.stop();
  }

  private onMessage(message: SessionMessage): void {
    if (!message || message.sessionId !== this.sessionId) return;
    if (message.type === 'activity' && Number.isFinite(message.at)) {
      this.lastActivityAt = Math.max(this.lastActivityAt, message.at || 0);
      localStorage.setItem(this.activityKey(), String(this.lastActivityAt));
      this.tick();
    } else if (message.type === 'refresh' && message.expiresAt) {
      this.expiresAt = Date.parse(message.expiresAt);
    }
  }

  private onStorage(event: StorageEvent): void {
    if (event.key === this.activityKey() && event.newValue) {
      this.lastActivityAt = Math.max(this.lastActivityAt, Number(event.newValue) || 0);
      this.tick();
    }
  }

  private activityKey(): string {
    return `ssfm_session_activity_${this.sessionId}`;
  }

  private heartbeatKey(): string {
    return `ssfm_session_heartbeat_${this.sessionId}`;
  }

  private refreshLockKey(): string {
    return `ssfm_session_refresh_lock_${this.sessionId}`;
  }
}
