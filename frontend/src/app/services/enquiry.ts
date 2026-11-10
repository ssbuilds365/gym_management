import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../environments/environment';

export interface EnquiryQuery {
  search?: string;
  status?: string;
  source?: string;
  assignedStaffId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export type EnquiryStatus =
  | 'NEW'
  | 'CONTACTED'
  | 'INTERESTED'
  | 'TRIAL_SCHEDULED'
  | 'FOLLOW_UP'
  | 'CONVERTED'
  | 'LOST';

export interface EnquiryRecord {
  _id: string;
  fullName: string;
  phone: string;
  email?: string;
  gender?: 'Male' | 'Female' | 'Other';
  age?: number | null;
  interestedIn?: string;
  source?: string;
  status: EnquiryStatus;
  planId?: any;
  assignedStaffId?: any;
  expectedJoiningDate?: string | null;
  nextFollowUpAt?: string | null;
  notes?: string;
  convertedMemberId?: any;
  convertedAt?: string | null;
  statusHistory?: Array<{
    previousStatus?: EnquiryStatus | null;
    newStatus?: EnquiryStatus;
    status: EnquiryStatus;
    changedAt: string;
    note?: string;
  }>;
  followUps?: Array<{
    followUpAt: string;
    outcome: string;
    notes: string;
    assignedStaffId?: any;
    nextFollowUpAt?: string | null;
    createdAt?: string;
  }>;
  trials?: Array<{
    startDate: string;
    endDate?: string | null;
    nextFollowUpAt?: string | null;
    assignedTrainerId?: any;
    feedback?: string;
    status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
    notes?: string;
  }>;
  [key: string]: any;
}

export interface MemberConversionPayload {
  email?: string;
  gender?: 'Male' | 'Female' | 'Other';
  dateOfBirth?: string | null;
  address?: string;
  emergencyContact?: string;
  joiningDate?: string;
  notes?: string;
}

@Injectable({ providedIn: 'root' })
export class EnquiryService {
  private readonly baseUrl = `${environment.apiUrl}/enquiries`;

  constructor(private readonly http: HttpClient) {}

  list(query: EnquiryQuery = {}) {
    let params = new HttpParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        params = params.set(key, String(value));
      }
    });
    return this.http.get<any>(this.baseUrl, { params });
  }

  get(id: string) {
    return this.http.get<any>(`${this.baseUrl}/${id}`);
  }

  create(data: object) {
    return this.http.post<any>(this.baseUrl, data);
  }

  update(id: string, data: object) {
    return this.http.put<any>(`${this.baseUrl}/${id}`, data);
  }

  delete(id: string) {
    return this.http.delete<any>(`${this.baseUrl}/${id}`);
  }

  updateStatus(id: string, status: string) {
    return this.http.patch<any>(`${this.baseUrl}/${id}/status`, { status });
  }

  addFollowUp(id: string, data: object) {
    return this.http.post<any>(`${this.baseUrl}/${id}/follow-ups`, data);
  }

  addTrial(id: string, data: object) {
    return this.http.post<any>(`${this.baseUrl}/${id}/trials`, data);
  }

  convert(id: string, data: MemberConversionPayload) {
    return this.http.post<any>(`${this.baseUrl}/${id}/convert`, data);
  }

  statusHistory(id: string) {
    return this.http.get<any>(`${this.baseUrl}/${id}/status-history`);
  }

  followUps(id: string) {
    return this.http.get<any>(`${this.baseUrl}/${id}/follow-ups`);
  }

  trials(id: string) {
    return this.http.get<any>(`${this.baseUrl}/${id}/trials`);
  }

  dashboard() {
    return this.http.get<any>(`${this.baseUrl}/dashboard`);
  }

  analytics(query: Pick<EnquiryQuery, 'from' | 'to'> = {}) {
    let params = new HttpParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value) params = params.set(key, value);
    });
    return this.http.get<any>(`${this.baseUrl}/analytics`, { params });
  }
}
