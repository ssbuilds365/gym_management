
import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class PaymentService {

  private apiUrl = `${environment.apiUrl}/payments`;

  constructor(private http: HttpClient) {}

  // Get all business payments
  getPayments(page = 1, limit = 25): Observable<any> {
    const params = new HttpParams()
      .set('page', page)
      .set('limit', limit);

    return this.http.get(this.apiUrl, { params });
  }

  // Create new payment
  createPayment(data: any): Observable<any> {
    return this.http.post(this.apiUrl, data);
  }

  getEligibleMembers(category: 'gym-membership' | 'personal-training'): Observable<any> {
    const params = new HttpParams()
      .set('category', category)
      .set('_cacheBust', Date.now());
    return this.http.get(`${this.apiUrl}/eligible-members`, { params });
  }

  recordPersonalTrainingPayment(packageId: string, data: object): Observable<any> {
    return this.http.post(
      `${environment.apiUrl}/trainers-staff/pt-packages/${encodeURIComponent(packageId)}/payments`,
      data
    );
  }

  // Get payment history of a specific member
  getMemberPayments(memberId: string): Observable<any> {
    return this.http.get(
      `${this.apiUrl}/member/${memberId}`
    );
  }

  getPaymentReceipt(paymentId: string): Observable<any> {
    return this.http.get(`${this.apiUrl}/${encodeURIComponent(paymentId)}/receipt`);
  }

}
