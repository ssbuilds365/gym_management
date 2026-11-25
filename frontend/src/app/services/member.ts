import { Injectable } from '@angular/core';
import { HttpClient, HttpParams, HttpHeaders } from '@angular/common/http';
import { EMPTY, Observable, expand, reduce } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class MemberService {

  private apiUrl = `${environment.apiUrl}/members`;

  constructor(private http: HttpClient) {}

  // Get Members
  getMembers(
    search: string = '',
    status: string = '',
    page: number = 1,
    limit: number = 10,
    from?: string,
    to?: string
  ): Observable<any> {

    let params = new HttpParams()
      .set('page', page)
      .set('limit', limit);

    if (search.trim()) {
      params = params.set('search', search.trim());
    }

    if (status) {
      params = params.set('status', status);
    }

    if (from && to) {
      params = params.set('from', from).set('to', to);
    }

    return this.http.get<any>(this.apiUrl, { params });
  }

  getAllMatchingMembers(
    search: string,
    status: string,
    from?: string,
    to?: string
  ): Observable<any[]> {
    const pageLimit = 100;

    return this.getMembers(search, status, 1, pageLimit, from, to).pipe(
      expand((response, index) => {
        const pagination = response.pagination;
        if (!pagination?.hasNextPage) return EMPTY;
        return this.getMembers(
          search,
          status,
          index + 2,
          pageLimit,
          from,
          to
        );
      }),
      reduce((members, response) => members.concat(response.members || []), [] as any[])
    );
  }

  // Add Member
  addMember(data: any): Observable<any> {
    return this.http.post<any>(this.apiUrl, data);
  }

  // Update Member
  updateMember(id: string, data: any): Observable<any> {
    return this.http.put<any>(
      `${this.apiUrl}/${id}`,
      data
    );
  }

  // Delete Member
  deleteMember(id: string): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}/${id}`);
  }

  getFaceStatus(memberId: string): Observable<any> {
    return this.http.get(`${environment.apiUrl}/biometric/credentials/status/${memberId}`);
  }

  getFaceDuplicateReport(): Observable<any> {
    return this.http.get(`${environment.apiUrl}/biometric/duplicates`);
  }

  registerFace(
    memberId: string,
    images: string[],
    consentTextVersion: string,
    replaceExisting = false
  ): Observable<any> {
    return this.http.post(`${environment.apiUrl}/biometric/credentials/member/${memberId}/face`, {
      images,
      consentGranted: true,
      consentTextVersion,
      replaceExisting
    });
  }

  registerFaceFromKiosk(
    memberId: string,
    images: string[],
    consentTextVersion: string,
    consentGranted: boolean,
    kioskToken: string,
    replaceExisting = false
  ): Observable<any> {
    const headers = new HttpHeaders({ Authorization: `Bearer ${kioskToken}` });
    return this.http.post(`${environment.apiUrl}/kiosk/staff/enrollment/face/${memberId}`, {
      images,
      consentGranted,
      consentTextVersion,
      replaceExisting
    }, { headers });
  }

  removeFace(memberId: string): Observable<any> {
    return this.http.delete(`${environment.apiUrl}/biometric/credentials/member/${memberId}/face`);
  }

  generateMemberQR(memberId: string): Observable<any> {
  return this.http.post(
    `${this.apiUrl}/${memberId}/generate-qr`,
    {}
  );
}

  previewMemberImport(file: File): Observable<any> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http.post(`${this.apiUrl}/import/preview`, formData);
  }

  downloadMemberImportTemplate(): Observable<Blob> {
    return this.http.get(`${this.apiUrl}/import/template`, { responseType: 'blob' });
  }

  confirmMemberImport(payload: any, idempotencyKey: string): Observable<any> {
    const headers = new HttpHeaders({ 'Idempotency-Key': idempotencyKey });
    return this.http.post(`${this.apiUrl}/import/confirm`, payload, { headers });
  }

  getMemberImportHistory(page = 1, limit = 20): Observable<any> {
    const params = new HttpParams().set('page', page).set('limit', limit);
    return this.http.get(`${this.apiUrl}/import/history`, { params });
  }

  getMemberImportBatch(batchId: string): Observable<any> {
    return this.http.get(`${this.apiUrl}/import/history/${batchId}`);
  }

  downloadMemberImportReport(batchId: string, format: 'csv' | 'xlsx' = 'csv'):
    Observable<Blob> {
    const params = new HttpParams().set('format', format);
    return this.http.get(`${this.apiUrl}/import/history/${batchId}/report`, {
      params,
      responseType: 'blob'
    });
  }

  previewMemberImportDeletion(batchId: string): Observable<any> {
    return this.http.get(`${this.apiUrl}/import/history/${batchId}/delete-preview`);
  }

  deleteImportedMembers(batchId: string): Observable<any> {
    return this.http.post(
      `${this.apiUrl}/import/history/${batchId}/delete`,
      { confirmation: 'DELETE' }
    );
  }

}