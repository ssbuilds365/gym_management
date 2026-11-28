import { CommonModule } from '@angular/common';
import { Component, EventEmitter, OnDestroy, OnInit, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PersonalTrainerService } from '../../services/personal-trainer';
import { finalize, Subscription, timeout } from 'rxjs';

@Component({
  selector: 'app-personal-trainer-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './personal-trainer-dashboard.html',
  styleUrl: './personal-trainer-dashboard.scss'
})
export class PersonalTrainerDashboard implements OnInit, OnDestroy {
  @Output() navigate = new EventEmitter<string>();
  period = 'month';
  fromDate = '';
  toDate = '';
  summaryLoading = true;
  financialLoading = true;
  sessionsLoading = true;
  plansLoading = true;
  summaryError = '';
  financialError = '';
  sessionsError = '';
  plansError = '';
  summary: any = null;
  financials: any = null;
  upcomingSessions: any[] = [];
  expiringPlans: any[] = [];
  private summaryRequest?: Subscription;
  private financialRequest?: Subscription;
  private sessionsRequest?: Subscription;
  private plansRequest?: Subscription;

  constructor(private readonly service: PersonalTrainerService) {}

  ngOnInit(): void {
    this.load();
  }

  ngOnDestroy(): void {
    this.summaryRequest?.unsubscribe();
    this.financialRequest?.unsubscribe();
    this.sessionsRequest?.unsubscribe();
    this.plansRequest?.unsubscribe();
  }

  load(): void {
    this.loadSummary();
    this.loadFinancials();
    this.loadSessions();
    this.loadExpiringPlans();
  }

  loadSummary(): void {
    this.summaryRequest?.unsubscribe();
    this.summaryLoading = true;
    this.summaryError = '';
    const request = this.service.getDashboardSummary()
      .pipe(timeout(12000), finalize(() => this.summaryLoading = false))
      .subscribe({
        next: response => this.summary = response?.success ? response.summary : null,
        error: error => this.summaryError = error?.name === 'TimeoutError'
          ? 'Member summary timed out.'
          : error.error?.message || 'Unable to load member summary.'
      });
    this.summaryRequest = request;
  }

  loadFinancials(): void {
    this.financialRequest?.unsubscribe();
    if (this.period === 'custom' && (!this.fromDate || !this.toDate)) {
      this.financialLoading = false;
      this.financialError = 'Select both custom date values';
      return;
    }
    this.financialLoading = true;
    this.financialError = '';
    const request = this.service.getDashboardFinancials(this.period, this.fromDate, this.toDate)
      .pipe(timeout(12000), finalize(() => this.financialLoading = false))
      .subscribe({
        next: response => this.financials = response?.success ? response.financials : null,
        error: error => this.financialError = error?.name === 'TimeoutError'
          ? 'Financial metrics timed out.'
          : error.error?.message || 'Unable to load financial metrics.'
      });
    this.financialRequest = request;
  }

  loadSessions(): void {
    this.sessionsRequest?.unsubscribe();
    this.sessionsLoading = true;
    this.sessionsError = '';
    const request = this.service.getDashboardSessions()
      .pipe(timeout(12000), finalize(() => this.sessionsLoading = false))
      .subscribe({
        next: response => this.upcomingSessions = response?.success ? (response.upcomingSessions || []) : [],
        error: error => this.sessionsError = error?.name === 'TimeoutError'
          ? 'Upcoming sessions timed out.'
          : error.error?.message || 'Unable to load upcoming sessions.'
      });
    this.sessionsRequest = request;
  }

  loadExpiringPlans(): void {
    this.plansRequest?.unsubscribe();
    this.plansLoading = true;
    this.plansError = '';
    const request = this.service.getDashboardExpiringPlans()
      .pipe(timeout(12000), finalize(() => this.plansLoading = false))
      .subscribe({
        next: response => this.expiringPlans = response?.success ? (response.expiringPlans || []) : [],
        error: error => this.plansError = error?.name === 'TimeoutError'
          ? 'Expiring plans timed out.'
          : error.error?.message || 'Unable to load expiring training plans.'
      });
    this.plansRequest = request;
  }

  currency(value: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 2
    }).format(Number(value) || 0);
  }

  remainingLabel(days: number): string {
    return days <= 0 ? 'Expires Today' : `${days} ${days === 1 ? 'Day' : 'Days'} Left`;
  }
}
