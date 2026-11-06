import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { EMPTY, Observable, expand, reduce } from 'rxjs';
import { environment } from '../../environments/environment';

export interface ExpenseQuery {
  search?: string;
  category?: string;
  status?: string;
  period?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
}

@Injectable({ providedIn: 'root' })
export class ExpenseService {
  private readonly baseUrl = `${environment.apiUrl}/expenses`;

  constructor(private readonly http: HttpClient) {}

  list(query: ExpenseQuery = {}): Observable<any> {
    return this.http.get(this.baseUrl, { params: this.toParams(query) });
  }

  get(id: string): Observable<any> {
    return this.http.get(`${this.baseUrl}/${id}`);
  }

  create(data: object): Observable<any> {
    return this.http.post(this.baseUrl, data);
  }

  update(id: string, data: object): Observable<any> {
    return this.http.put(`${this.baseUrl}/${id}`, data);
  }

  delete(id: string): Observable<any> {
    return this.http.delete(`${this.baseUrl}/${id}`);
  }

  categories(): Observable<any> {
    return this.http.get(`${this.baseUrl}/categories`);
  }

  createCategory(name: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/categories`, { name });
  }

  updateCategory(id: string, data: object): Observable<any> {
    return this.http.put(`${this.baseUrl}/categories/${id}`, data);
  }

  report(query: ExpenseQuery): Observable<any> {
    return this.http.get(`${this.baseUrl}/reports`, { params: this.toParams(query) });
  }

  export(query: ExpenseQuery, format: 'csv' | 'xlsx'): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/export`, {
      params: this.toParams({ ...query, format }),
      responseType: 'blob'
    });
  }

  allMatching(query: ExpenseQuery): Observable<any[]> {
    const pageSize = 100;
    return this.list({ ...query, page: 1, limit: pageSize }).pipe(
      expand((response, index) => {
        const totalPages = Number(response.pagination?.totalPages || 0);
        if (index + 1 >= totalPages) return EMPTY;
        return this.list({ ...query, page: index + 2, limit: pageSize });
      }),
      reduce((rows, response) => rows.concat(response.expenses || []), [] as any[])
    );
  }

  private toParams(query: object): HttpParams {
    let params = new HttpParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        params = params.set(key, String(value));
      }
    });
    return params;
  }
}
