import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class DashboardService {

  private apiUrl = `${environment.apiUrl}/dashboard`;
  private readonly refreshSubject = new Subject<void>();
  readonly refreshRequested$ = this.refreshSubject.asObservable();

  constructor(private http: HttpClient) {}

  getDashboardStats(): Observable<any> {
    return this.http.get(
      `${this.apiUrl}/stats`,
      { params: { _cacheBust: Date.now() } }
    );
  }

  getTodaysBirthdays(): Observable<any> {
    return this.http.get(
      `${this.apiUrl}/todays-birthdays`,
      { params: { _cacheBust: Date.now() } }
    );
  }

  getMembershipExpiry(filters: {
    status?: string;
    search?: string;
    planId?: string;
    page?: number;
    limit?: number;
    sort?: 'asc' | 'desc';
  } = {}): Observable<any> {
    let params = new HttpParams().set('_cacheBust', Date.now());
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') {
        params = params.set(key, value);
      }
    });
    return this.http.get(`${this.apiUrl}/membership-expiry`, { params });
  }

  requestRefresh(): void {
    this.refreshSubject.next();
  }
}