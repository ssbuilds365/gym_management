import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class AttendanceService {

  private apiUrl = `${environment.apiUrl}/attendance`;

  constructor(private http: HttpClient) {}

  // Mark Check-in
  checkIn(data: any): Observable<any> {
    return this.http.post(`${this.apiUrl}/check-in`, data);
  }

  // Mark Check-out
  checkOut(memberId: string): Observable<any> {
    return this.http.post(`${this.apiUrl}/check-out`, { memberId });
  }

  // Get Daily Attendance
  getDailyAttendance(date?: string): Observable<any> {
    let params = new HttpParams();

    if (date) {
      params = params.set('date', date);
    }

    return this.http.get(
      `${this.apiUrl}/daily`,
      { params }
    );
  }

  // Get Member Attendance History
  getMemberAttendance(memberId: string): Observable<any> {
    return this.http.get(`${this.apiUrl}/member/${memberId}`);
  }

  checkInWithQR(qrToken: string): Observable<any> {
  return this.http.post(
    `${this.apiUrl}/qr-check-in`,
    { qrToken }
  );
}
}