import { Injectable } from '@angular/core';
import {
  HttpClient,
  HttpParams
} from '@angular/common/http';
import { EMPTY, Observable, expand, reduce } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ManagementService {
  private readonly baseUrl = environment.apiUrl;

  constructor(private readonly http: HttpClient) {}

  getStaff(options: {
    role?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  } = {}): Observable<any> {
    let params = new HttpParams();
    Object.entries(options).forEach(([key, value]) => {
      if (value !== undefined && value !== '') params = params.set(key, value);
    });
    return this.http.get(`${this.baseUrl}/trainers-staff`, { params });
  }

  createStaff(data: object): Observable<any> {
    return this.http.post(`${this.baseUrl}/trainers-staff`, data);
  }

  updateStaff(id: string, data: object): Observable<any> {
    return this.http.put(`${this.baseUrl}/trainers-staff/${id}`, data);
  }

  deleteStaff(id: string): Observable<any> {
    return this.http.delete(`${this.baseUrl}/trainers-staff/${id}`);
  }

  getTrainerAssignments(id: string): Observable<any> {
    return this.http.get(`${this.baseUrl}/trainers-staff/${id}/assignments`);
  }

  assignMemberToTrainer(id: string, memberId: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/trainers-staff/${id}/assignments`, { memberId });
  }

  removeTrainerAssignment(id: string, memberId: string): Observable<any> {
    return this.http.delete(`${this.baseUrl}/trainers-staff/${id}/assignments/${memberId}`);
  }

  getTrainerStaffReport(filters: {
    role?: string;
    status?: string;
    from?: string;
    to?: string;
  }): Observable<any> {
    let params = new HttpParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params = params.set(key, value);
    });
    return this.http.get(`${this.baseUrl}/trainers-staff/reports`, { params });
  }

  getReport(filters: Record<string, string | number | boolean | undefined>): Observable<any> {
    let params = new HttpParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') params = params.set(key, value);
    });
    return this.http.get(`${this.baseUrl}/reports`, { params });
  }

  getAllReportRows(
    filters: Record<string, string | number | boolean | undefined>
  ): Observable<any[]> {
    const pageSize = 100;
    return this.getReport({
      ...filters,
      detailsOnly: true,
      page: 1,
      limit: pageSize
    }).pipe(
      expand((response, index) => {
        const detail = response.detail;
        if (!detail?.totalPages || index + 1 >= detail.totalPages) return EMPTY;
        return this.getReport({
          ...filters,
          detailsOnly: true,
          page: index + 2,
          limit: pageSize
        });
      }),
      reduce((rows, response) => rows.concat(response.detail?.records || []), [] as any[])
    );
  }

  getSettings(): Observable<any> {
    return this.http.get(`${this.baseUrl}/business/settings`);
  }

  updateSettings(data: object): Observable<any> {
    return this.http.put(`${this.baseUrl}/business/settings`, data);
  }

}
