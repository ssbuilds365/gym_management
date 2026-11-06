import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class MembershipPlanService {

  private apiUrl = `${environment.apiUrl}/membership-plans`;
  private memberMembershipsUrl = `${environment.apiUrl}/member-memberships`;

  constructor(private http: HttpClient) {}

  getPlans(): Observable<any> {
    return this.http.get<any>(this.apiUrl);
  }

  assignMembership(data: any): Observable<any> {
  return this.http.post<any>(
    `${this.memberMembershipsUrl}/assign`,
    data
  );
}

  addPlan(data: any): Observable<any> {
    return this.http.post<any>(this.apiUrl, data);
  }

  updatePlan(id: string, data: any): Observable<any> {
    return this.http.put<any>(`${this.apiUrl}/${id}`, data);
  }

  deletePlan(id: string): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}/${id}`);
  }

  getMemberMemberships(memberId: string): Observable<any> {
  return this.http.get<any>(
    `${this.memberMembershipsUrl}/member/${memberId}`
  );
}
}