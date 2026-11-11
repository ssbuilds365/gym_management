import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { EMPTY, Observable, expand, reduce } from 'rxjs';
import { environment } from '../../environments/environment';
import { GlobalMessageMember } from '../utils/global-message';

@Injectable({ providedIn: 'root' })
export class GlobalMessageService {
  private readonly apiUrl = `${environment.apiUrl}/global-messages`;

  constructor(private readonly http: HttpClient) {}

  summary(): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/summary`);
  }

  members(filter: string, search: string, page = 1, limit = 50): Observable<any> {
    const params = new HttpParams()
      .set('filter', filter)
      .set('search', search)
      .set('page', page)
      .set('limit', limit);
    return this.http.get<any>(`${this.apiUrl}/members`, { params });
  }

  allMembers(filter: string, search: string): Observable<GlobalMessageMember[]> {
    const limit = 100;
    return this.members(filter, search, 1, limit).pipe(
      expand((response, index) => {
        const totalPages = Number(response.pagination?.totalPages || 1);
        return index + 1 < totalPages
          ? this.members(filter, search, index + 2, limit)
          : EMPTY;
      }),
      reduce((members, response) => members.concat(response.members || []), [] as GlobalMessageMember[])
    );
  }

  createCampaign(data: { name: string; message: string; memberIds: string[] }): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/campaigns`, data);
  }

  campaigns(page = 1, limit = 20): Observable<any> {
    const params = new HttpParams().set('page', page).set('limit', limit);
    return this.http.get<any>(`${this.apiUrl}/campaigns`, { params });
  }

  campaign(id: string, page = 1, limit = 50): Observable<any> {
    const params = new HttpParams().set('page', page).set('limit', limit);
    return this.http.get<any>(`${this.apiUrl}/campaigns/${encodeURIComponent(id)}`, { params });
  }

  updateCampaignStatus(id: string, status: string): Observable<any> {
    return this.http.patch<any>(
      `${this.apiUrl}/campaigns/${encodeURIComponent(id)}/status`,
      { status }
    );
  }

  updateRecipient(id: string, memberId: string, status: string): Observable<any> {
    return this.http.patch<any>(
      `${this.apiUrl}/campaigns/${encodeURIComponent(id)}/recipients/${encodeURIComponent(memberId)}`,
      { status }
    );
  }

  advanceCampaign(id: string): Observable<any> {
    return this.http.patch<any>(
      `${this.apiUrl}/campaigns/${encodeURIComponent(id)}/advance`,
      {}
    );
  }
}
