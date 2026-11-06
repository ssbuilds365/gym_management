import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, finalize, tap } from 'rxjs';
import { environment } from '../../environments/environment';

const SESSION_REFERENCE_KEY = 'ssfm_session_reference';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly apiUrl = `${environment.apiUrl}/auth`;
  private authenticated = false;

  constructor(private readonly http: HttpClient) {}

  register(data: unknown): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/register`, data)
      .pipe(tap(response => this.acceptAuthentication(response)));
  }

  login(data: unknown): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/login`, data)
      .pipe(tap(response => this.acceptAuthentication(response)));
  }

  getProfile(): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/profile`, {
      params: { _cacheBust: Date.now() }
    }).pipe(tap(response => {
      if (response?.success && response?.session?.id) {
        this.authenticated = true;
        this.writeSessionReference(response.session.id);
        this.storeProfile(response);
      }
    }));
  }

  recordActivity(): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/activity`, {});
  }

  refreshSession(): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/refresh`, {});
  }

  getSessions(): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/sessions`);
  }

  revokeSession(sessionId: string): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}/sessions/${encodeURIComponent(sessionId)}`);
  }

  revokeOtherSessions(): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}/sessions/others`);
  }

  revokeAllSessions(): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}/sessions/all`);
  }

  changePassword(data: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }): Observable<any> {
    return this.http.put<any>(`${this.apiUrl}/change-password`, data);
  }

  forgotPassword(email: string): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/forgot-password`, { email });
  }

  validateResetToken(token: string): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/validate-reset-token`, { token });
  }

  resetPassword(data: {
    token: string;
    newPassword: string;
    confirmPassword: string;
  }): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/reset-password`, data);
  }

  logout(): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/logout`, {}).pipe(
      finalize(() => this.clearLocalSession())
    );
  }

  isLoggedIn(): boolean {
    return this.authenticated;
  }

  getSessionReference(): string {
    return localStorage.getItem(SESSION_REFERENCE_KEY) || '';
  }

  clearLocalSession(): void {
    this.authenticated = false;
    localStorage.removeItem('token');
    localStorage.removeItem('owner');
    localStorage.removeItem('business');
    localStorage.removeItem(SESSION_REFERENCE_KEY);
  }

  private acceptAuthentication(response: any): void {
    if (!response?.success || !response?.session?.id) return;
    this.authenticated = true;
    this.storeProfile(response);
    this.writeSessionReference(response.session.id);
    localStorage.removeItem('token');
  }

  private storeProfile(response: any): void {
    if (response.owner) localStorage.setItem('owner', JSON.stringify(response.owner));
    if (response.business) localStorage.setItem('business', JSON.stringify(response.business));
  }

  private writeSessionReference(sessionId: string): void {
    localStorage.setItem(SESSION_REFERENCE_KEY, sessionId);
  }
}
