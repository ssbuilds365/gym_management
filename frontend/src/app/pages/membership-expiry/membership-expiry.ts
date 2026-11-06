import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  EventEmitter,
  OnDestroy,
  OnInit,
  Output
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize, Subscription } from 'rxjs';
import { DashboardService } from '../../services/dashboard';
import { MembershipPlanService } from '../../services/membership-plan';

export interface ExpiringMember {
  memberId: string;
  membershipId: string;
  fullName: string;
  phone: string;
  planName: string;
  planId: string;
  startDate: string;
  endDate: string;
  endDateLocal: string;
  remainingDays: number;
  status: 'expiringSoon' | 'today' | 'expired';
}

interface MembershipPlan {
  _id: string;
  planName: string;
  duration: number;
  durationType: 'Days' | 'Months' | 'Years';
  price: number;
  status: string;
}

@Component({
  selector: 'app-membership-expiry',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './membership-expiry.html',
  styleUrl: './membership-expiry.scss'
})
export class MembershipExpiry implements OnInit, OnDestroy {
  @Output() memberSelected = new EventEmitter<ExpiringMember>();

  expiringNext7DaysCount = 0;
  expiringTodayCount = 0;
  expiredCount = 0;
  todayDate = '';
  timeZone = '';
  upcomingMembers: ExpiringMember[] = [];
  members: ExpiringMember[] = [];
  plans: Array<{ _id: string; planName: string }> = [];
  page = 1;
  limit = 10;
  total = 0;
  totalPages = 0;
  search = '';
  statusFilter = 'all';
  planFilter = '';
  sortDirection: 'asc' | 'desc' = 'asc';
  loading = false;
  errorMessage = '';
  successMessage = '';
  showAll = false;
  showRenewal = false;
  selectedMember: ExpiringMember | null = null;
  renewalPlans: MembershipPlan[] = [];
  selectedPlanId = '';
  renewalStartDate = '';
  plansLoading = false;
  renewalLoading = false;
  renewalError = '';

  private expiryRequest?: Subscription;
  private plansRequest?: Subscription;
  private refreshSubscription?: Subscription;
  private searchTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly dashboard: DashboardService,
    private readonly membershipPlans: MembershipPlanService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.refreshSubscription = this.dashboard.refreshRequested$.subscribe(() => {
      this.loadExpiry();
    });
    this.loadExpiry();
  }

  ngOnDestroy(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.expiryRequest?.unsubscribe();
    this.plansRequest?.unsubscribe();
    this.refreshSubscription?.unsubscribe();
  }

  loadExpiry(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = undefined;
    }
    this.expiryRequest?.unsubscribe();
    this.loading = true;
    this.errorMessage = '';
    const filters = this.showAll
      ? {
          status: this.statusFilter,
          search: this.search,
          planId: this.planFilter,
          page: this.page,
          limit: this.limit,
          sort: this.sortDirection
        }
      : { status: 'upcoming', page: 1, limit: 5, sort: 'asc' as const };

    this.expiryRequest = this.dashboard.getMembershipExpiry(filters)
      .pipe(finalize(() => {
        this.loading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.expiringNext7DaysCount = Number(response.expiringNext7DaysCount || 0);
          this.expiringTodayCount = Number(response.expiringTodayCount || 0);
          this.expiredCount = Number(response.expiredCount || 0);
          this.todayDate = response.todayDate || this.todayDate;
          this.timeZone = response.timeZone || this.timeZone;
          this.plans = response.plans || [];
          this.upcomingMembers = response.upcomingMembers || [];
          if (this.showAll) {
            this.members = response.members || [];
            this.total = response.pagination?.total || 0;
            this.totalPages = response.pagination?.totalPages || 0;
          }
        },
        error: error => {
          console.error('Membership expiry loading error:', error);
          this.errorMessage =
            error.error?.message || 'Unable to load membership expiry information.';
        }
      });
  }

  openAll(): void {
    this.showAll = true;
    this.statusFilter = 'all';
    this.search = '';
    this.planFilter = '';
    this.sortDirection = 'asc';
    this.page = 1;
    this.successMessage = '';
    this.loadExpiry();
  }

  closeAll(): void {
    this.showAll = false;
    this.members = [];
    this.loadExpiry();
  }

  onSearchChange(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.page = 1;
    this.expiryRequest?.unsubscribe();
    this.loading = true;
    this.errorMessage = '';
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      this.loadExpiry();
    }, 300);
  }

  onFilterChange(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = undefined;
    }
    this.page = 1;
    this.loadExpiry();
  }

  changePage(delta: number): void {
    const nextPage = Math.max(1, Math.min(this.totalPages, this.page + delta));
    if (nextPage === this.page) return;
    this.page = nextPage;
    this.loadExpiry();
  }

  statusLabel(status: ExpiringMember['status']): string {
    if (status === 'today') return 'Expires Today';
    if (status === 'expired') return 'Expired';
    return 'Expiring Soon';
  }

  remainingLabel(member: ExpiringMember): string {
    if (member.remainingDays < 0) {
      const days = Math.abs(member.remainingDays);
      return `Expired ${days} day${days === 1 ? '' : 's'} ago`;
    }
    if (member.remainingDays === 0) return 'Expires today';
    return `${member.remainingDays} day${member.remainingDays === 1 ? '' : 's'} left`;
  }

  formatDate(dateKey: string): string {
    if (!dateKey) return '—';
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(date);
  }

  whatsappUrl(member: ExpiringMember): string | null {
    const rawPhone = String(member.phone || '').trim();
    if (!/^\+?[\d\s().-]{7,20}$/.test(rawPhone)) return null;
    const phone = rawPhone.replace(/\D/g, '');
    if (phone.length < 7 || phone.length > 15) return null;
    const message = `Hello ${member.fullName}, your gym membership is expiring on ${this.formatDate(member.endDateLocal)}. Please contact us to renew your membership and continue your fitness journey. Thank you!`;
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  }

  contactMember(member: ExpiringMember): void {
    const url = this.whatsappUrl(member);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  openMember(member: ExpiringMember): void {
    this.memberSelected.emit(member);
  }

  openRenewal(member: ExpiringMember): void {
    if (this.renewalLoading) return;
    this.selectedMember = member;
    this.selectedPlanId = '';
    this.renewalStartDate = member.remainingDays >= 0
      ? this.shiftDate(member.endDateLocal, 1)
      : this.todayDate;
    this.renewalError = '';
    this.showRenewal = true;
    this.plansLoading = true;
    this.plansRequest?.unsubscribe();
    this.plansRequest = this.membershipPlans.getPlans()
      .pipe(finalize(() => {
        this.plansLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          const allPlans = response.plans || response.membershipPlans || [];
          this.renewalPlans = allPlans.filter((plan: MembershipPlan) => plan.status === 'Active');
        },
        error: error => {
          console.error('Membership renewal plans loading error:', error);
          this.renewalError = error.error?.message || 'Unable to load membership plans.';
        }
      });
  }

  private shiftDate(dateKey: string, days: number): string {
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  closeRenewal(): void {
    if (this.renewalLoading) return;
    this.showRenewal = false;
    this.selectedMember = null;
    this.renewalError = '';
  }

  renewMembership(): void {
    if (
      this.renewalLoading ||
      !this.selectedMember ||
      !this.selectedPlanId ||
      !this.renewalStartDate ||
      this.renewalPlans.length === 0
    ) return;

    this.renewalLoading = true;
    this.renewalError = '';
    this.membershipPlans.assignMembership({
      memberId: this.selectedMember.memberId,
      planId: this.selectedPlanId,
      startDate: this.renewalStartDate,
      paidAmount: 0
    }).pipe(finalize(() => {
      this.renewalLoading = false;
      this.changeDetector.markForCheck();
    }))
      .subscribe({
        next: response => {
          this.showRenewal = false;
          this.successMessage =
            response.message || 'Membership renewed. Record any payment in Payments & Fees.';
          this.selectedMember = null;
          this.dashboard.requestRefresh();
        },
        error: error => {
          console.error('Membership renewal error:', error);
          this.renewalError =
            error.error?.message || 'Unable to renew this membership.';
        }
      });
  }
}
