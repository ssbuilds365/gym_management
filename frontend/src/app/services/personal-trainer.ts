import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class PersonalTrainerService {
  private readonly apiUrl = `${environment.apiUrl}/personal-trainer`;

  constructor(private readonly http: HttpClient) {}

  getDashboard(period = 'month', from = '', to = ''): Observable<any> {
    let params = new HttpParams().set('period', period);
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    return this.http.get(`${this.apiUrl}/dashboard`, { params });
  }

  getDashboardSummary(): Observable<any> {
    return this.http.get(`${this.apiUrl}/dashboard/summary`);
  }

  getDashboardFinancials(period = 'month', from = '', to = ''): Observable<any> {
    let params = new HttpParams().set('period', period);
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    return this.http.get(`${this.apiUrl}/dashboard/financials`, { params });
  }

  getDashboardSessions(): Observable<any> {
    return this.http.get(`${this.apiUrl}/dashboard/sessions`);
  }

  getDashboardExpiringPlans(): Observable<any> {
    return this.http.get(`${this.apiUrl}/dashboard/expiring-plans`);
  }

  listSessions(date = '', status = ''): Observable<any> {
    let params = new HttpParams();
    if (date) params = params.set('date', date);
    if (status) params = params.set('status', status);
    return this.http.get(`${this.apiUrl}/sessions`, { params });
  }

  createSession(data: object): Observable<any> {
    return this.http.post(`${this.apiUrl}/sessions`, data);
  }

  updateSession(id: string, data: object): Observable<any> {
    return this.http.put(`${this.apiUrl}/sessions/${id}`, data);
  }

  deleteSession(id: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/sessions/${id}`);
  }

  listNotes(search = ''): Observable<any> {
    let params = new HttpParams();
    if (search) params = params.set('search', search);
    return this.http.get(`${this.apiUrl}/notes`, { params });
  }

  createNote(data: object): Observable<any> {
    return this.http.post(`${this.apiUrl}/notes`, data);
  }

  updateNote(id: string, data: object): Observable<any> {
    return this.http.put(`${this.apiUrl}/notes/${id}`, data);
  }

  deleteNote(id: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/notes/${id}`);
  }
}
