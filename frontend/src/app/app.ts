
import { ChangeDetectorRef, Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { filter, finalize, Subscription } from 'rxjs';

import { AuthService } from './services/auth';
import { DashboardService } from './services/dashboard';

import { Members } from './pages/members/members';
import { MembershipPlans } from './pages/membership-plans/membership-plans';
import { Attendance } from './pages/attendance/attendance';
import { Payments } from './pages/payments/payments';
import { TrainersStaff } from './pages/trainers-staff/trainers-staff';
import { Reports } from './pages/reports/reports';
import { BusinessSettings } from './pages/settings/settings';
import { ExpiringMember, MembershipExpiry } from './pages/membership-expiry/membership-expiry';
import { ExpenseTracker } from './pages/expenses/expense-tracker';
import { DatabaseStorage } from './pages/database-storage/database-storage';
import { SessionActivityService } from './services/session-activity';

import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    Members,
    MembershipPlans,
    Attendance,
    Payments,
    TrainersStaff,
    Reports,
    BusinessSettings,
    MembershipExpiry,
    ExpenseTracker,
    DatabaseStorage
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy {

  readonly appName = environment.appName;
  readonly appVersion = environment.appVersion;

  selectedMenu = 'Dashboard';
  mobileMenuOpen = false;

  isAuthenticated = false;
  sessionChecking = true;
  sessionVerificationError = '';
  sessionWarning = false;
  sessionRemainingMs = 30 * 60 * 1000;

  businessName = environment.appName;
  ownerName = 'Admin';

  stats: any[] = [];
  recentMembers: any[] = [];
  memberToFocus: ExpiringMember | null = null;
  readonly dashboardStatPlaceholders = [0, 1, 2, 3];

  dashboardLoading = false;
  dashboardError = '';
  todayAttendance = 0;
  dashboardTimeZone = 'Asia/Kolkata';
  collections: {
    today: number;
    week: number;
    month: number;
    monthlyRevenue: Array<{ key: string; month: string; revenue: number }>;
  } | null = null;
  private dashboardLoadedAt = 0;
  private dashboardSessionId = '';
  private lastVerifiedSessionId = '';

  private sessionVerificationStarted = false;
  private routerSubscription?: Subscription;
  private dashboardRefreshSubscription?: Subscription;
  private sessionWarningSubscription?: Subscription;
  private sessionRemainingSubscription?: Subscription;
  private sessionExpiredSubscription?: Subscription;
  private dashboardRefreshQueued = false;
  private readonly sessionReferenceHandler = (event: StorageEvent) => {
    if (event.key !== 'ssfm_session_reference') return;
    if (event.newValue === this.lastVerifiedSessionId) return;
    this.isAuthenticated = false;
    this.lastVerifiedSessionId = '';
    this.sessionActivity.stop();
    this.verifySession();
  };

  // SIDEBAR MENU GROUPS
  menuGroups = [
    {
      title: 'MAIN MENU',
      items: [
        { name: 'Dashboard', icon: '⌂' },
        { name: 'Members', icon: '♙' },
        { name: 'Membership Plans', icon: '▤' },
        { name: 'Attendance', icon: '◷' },
        { name: 'Payments & Fees', icon: '₹' }
      ]
    },
    {
      title: 'MANAGEMENT',
      items: [
        { name: 'Expense Tracker', icon: '₹' },
        { name: 'Trainers & Staff', icon: '♟' },
        { name: 'Reports & Analytics', icon: '▥' }
      ]
    },
    {
      title: 'SYSTEM',
      items: [
        { name: 'Settings', icon: '⚙' },
        { name: 'Database Storage', icon: '▦' }
      ]
    }
  ];

  constructor(
    private router: Router,
    private authService: AuthService,
    private dashboardService: DashboardService,
    private changeDetector: ChangeDetectorRef,
    private sessionActivity: SessionActivityService
  ) {}

  ngOnInit(): void {
    this.dashboardRefreshSubscription = this.dashboardService.refreshRequested$
      .subscribe(() => {
        if (!this.isAuthenticated) return;
        if (this.selectedMenu === 'Dashboard') {
          if (this.dashboardLoading) {
            this.dashboardRefreshQueued = true;
          } else {
            this.loadDashboardData(true);
          }
        }
      });
    this.sessionWarningSubscription = this.sessionActivity.warning$
      .subscribe(value => {
        this.sessionWarning = value;
        this.changeDetector.markForCheck();
      });
    this.sessionRemainingSubscription = this.sessionActivity.remainingMs$
      .subscribe(value => {
        this.sessionRemainingMs = value;
        this.changeDetector.markForCheck();
      });
    this.sessionExpiredSubscription = this.sessionActivity.sessionExpired$
      .subscribe(reason => this.onSessionExpired(reason));
    window.addEventListener('storage', this.sessionReferenceHandler);

    // Check session whenever route changes.
    this.routerSubscription = this.router.events
      .pipe(
        filter(event => event instanceof NavigationEnd)
      )
      .subscribe(() => {
        this.verifySession();
      });

    // Initial session check
    this.verifySession();
  }

  ngOnDestroy(): void {
    this.routerSubscription?.unsubscribe();
    this.dashboardRefreshSubscription?.unsubscribe();
    this.sessionWarningSubscription?.unsubscribe();
    this.sessionRemainingSubscription?.unsubscribe();
    this.sessionExpiredSubscription?.unsubscribe();
    this.sessionActivity.stop();
    window.removeEventListener('storage', this.sessionReferenceHandler);
  }

  // SESSION VERIFICATION
  verifySession(): void {
    const currentUrl = this.router.url;
    if (
      currentUrl.startsWith('/login') ||
      currentUrl.startsWith('/register') ||
      currentUrl.startsWith('/forgot-password') ||
      currentUrl.startsWith('/reset-password')
    ) {
      this.sessionChecking = false;
      this.sessionVerificationError = '';
      return;
    }

    const storedSessionId = this.authService.getSessionReference();
    if (this.isAuthenticated && storedSessionId && storedSessionId === this.lastVerifiedSessionId) {
      return;
    }

    if (this.sessionVerificationStarted) {
      return;
    }

    this.sessionVerificationStarted = true;
    this.sessionChecking = true;
    this.sessionVerificationError = '';

    this.authService.getProfile()
      .pipe(
        finalize(() => {
          this.sessionChecking = false;
          this.sessionVerificationStarted = false;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: (response) => {
          if (
            response?.success === true &&
            response?.owner &&
            response?.business &&
            response?.session?.id
          ) {
            this.isAuthenticated = true;
            this.lastVerifiedSessionId = response.session.id;
            this.sessionActivity.start(response.session);

            if (this.dashboardSessionId && this.dashboardSessionId !== response.session.id) {
              this.stats = [];
              this.recentMembers = [];
              this.collections = null;
              this.dashboardLoadedAt = 0;
            }

            this.ownerName = response.owner.name || 'Owner';
            this.businessName = response.business.businessName || this.appName;
            this.selectedMenu = currentUrl.startsWith('/members') ? 'Members' : 'Dashboard';
            this.loadDashboardData();
          } else {
            this.handleInvalidSession('revoked');
          }
        },
        error: (error) => {
          console.error('Session verification failed:', error);
          if (error.status === 401) {
            const reason = error.error?.code === 'SESSION_EXPIRED' ? 'expired'
              : error.error?.code === 'SESSION_REVOKED' ? 'revoked'
                : '';
            this.handleInvalidSession(reason);
          } else {
            this.isAuthenticated = false;
            this.sessionVerificationError =
              error.error?.message || 'We could not verify your session. Check your connection and try again.';
          }
        }
      });
  }

  retrySessionVerification(): void {
    this.sessionVerificationError = '';
    this.verifySession();
  }

  backToLogin(): void {
    this.sessionActivity.stop();
    this.authService.logout().subscribe({
      next: () => this.finishLogout(),
      error: () => this.finishLogout()
    });
  }

  stayLoggedIn(): void {
    this.sessionActivity.stayLoggedIn();
  }

  get sessionRemainingLabel(): string {
    const totalSeconds = Math.ceil(this.sessionRemainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  // AUTH ROUTE CHECK
  get isAuthRoute(): boolean {
    return (
      this.router.url.startsWith('/register') ||
      this.router.url.startsWith('/login') ||
      this.router.url.startsWith('/forgot-password') ||
      this.router.url.startsWith('/reset-password')
    );
  }

  // LOGOUT
  logout(reason = ''): void {
    this.sessionActivity.stop();
    this.authService.logout().subscribe({
      next: () => this.finishLogout(reason),
      error: () => this.finishLogout(reason)
    });
  }

  private finishLogout(reason = ''): void {
    this.isAuthenticated = false;
    this.sessionChecking = false;
    this.lastVerifiedSessionId = '';
    this.dashboardSessionId = '';
    this.dashboardLoadedAt = 0;
    this.stats = [];
    this.recentMembers = [];
    this.dashboardError = '';
    this.todayAttendance = 0;
    this.dashboardTimeZone = 'Asia/Kolkata';
    this.collections = null;

    this.ownerName = 'Admin';
    this.businessName = this.appName;
    this.selectedMenu = 'Dashboard';

    this.mobileMenuOpen = false;
    this.sessionWarning = false;
    this.sessionVerificationError = '';
    this.router.navigate(['/login'], {
      queryParams: reason ? { reason } : undefined
    });
  }

  private handleInvalidSession(reason: string): void {
    this.sessionActivity.stop();
    this.authService.clearLocalSession();
    this.isAuthenticated = false;
    this.lastVerifiedSessionId = '';
    this.sessionVerificationError = '';
    this.router.navigate(['/login'], {
      queryParams: reason ? { reason } : undefined
    });
  }

  private onSessionExpired(reason: 'inactive' | 'revoked'): void {
    this.handleInvalidSession(reason);
  }

  // SIDEBAR MENU
  selectMenu(name: string): void {

    if (name !== 'Members') this.memberToFocus = null;
    this.selectedMenu = name;
    this.mobileMenuOpen = false;

    if (name === 'Dashboard') {
      this.loadDashboardData(true);
    }
  }

  openMemberFromExpiry(member: ExpiringMember): void {
    this.memberToFocus = member;
    this.selectMenu('Members');
  }

  // MOBILE MENU
  toggleMobileMenu(): void {
    this.mobileMenuOpen = !this.mobileMenuOpen;
  }

  // CURRENT DATE
  get currentDate(): string {
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).format(new Date());
  }

  // DASHBOARD API
  loadDashboardData(force = false): void {

    if (this.dashboardLoading) {
      return;
    }

    if (
      !force &&
      this.stats.length > 0 &&
      Date.now() - this.dashboardLoadedAt < 60_000
    ) {
      return;
    }

    this.dashboardLoading = true;
    this.dashboardError = '';

    this.dashboardService.getDashboardStats()
      .pipe(
        finalize(() => {
          this.dashboardLoading = false;
          this.changeDetector.markForCheck();
          if (this.dashboardRefreshQueued) {
            this.dashboardRefreshQueued = false;
            this.loadDashboardData(true);
          }
        })
      )
      .subscribe({

        next: (response) => {

          if (!response?.success || !response?.stats) {
            this.dashboardError = 'Unable to load dashboard data.';
            return;
          }

          const data = response.stats;
          this.dashboardTimeZone = response.timeZone || 'Asia/Kolkata';
          this.collections = response.collections
            ? {
                today: Number(response.collections.today || 0),
                week: Number(response.collections.week || 0),
                month: Number(response.collections.month || 0),
                monthlyRevenue: Array.isArray(response.collections.monthlyRevenue)
                  ? response.collections.monthlyRevenue.map((item: any) => ({
                      key: String(item.key),
                      month: String(item.month),
                      revenue: Number(item.revenue || 0)
                    }))
                  : []
              }
            : null;
          this.dashboardLoadedAt = Date.now();
          this.dashboardSessionId = this.lastVerifiedSessionId;

          this.todayAttendance = data.todayAttendance ?? 0;

          this.stats = [
            {
              title: 'Total Members',
              value: (data.totalMembers ?? 0).toLocaleString('en-IN'),
              change: '',
              description: 'All registered members',
              icon: '♙',
              color: 'blue'
            },
            {
              title: 'Active Members',
              value: (data.activeMembers ?? 0).toLocaleString('en-IN'),
              change: '',
              description: 'Currently active',
              icon: '✓',
              color: 'green'
            },
            {
              title: 'Total Collected',
              value: '₹' + (data.totalCollected ?? 0).toLocaleString('en-IN'),
              change: '',
              description: 'Membership collection',
              icon: '₹',
              color: 'orange'
            },
            {
              title: 'Pending Fees',
              value: '₹' + (data.totalPending ?? 0).toLocaleString('en-IN'),
              change: '',
              description: 'Remaining membership fees',
              icon: '◷',
              color: 'red'
            }
          ];

          this.recentMembers = (response.recentMembers || []).map(
            (member: any) => ({
              id: member._id?.slice(-6).toUpperCase() || '-',
              name: member.fullName || 'Member',
              phone: member.phone || '-',
              plan: '-',
              joining: new Date(
                member.joiningDate || member.createdAt
              ).toLocaleDateString('en-IN'),
              status: member.status || 'Active'
            })
          );
        },

        error: (error) => {

          console.error('Dashboard API Error:', error);
          this.collections = null;

          this.dashboardError =
            'Unable to load dashboard data. Please try again.';
        }
      });
  }

  get maxMonthlyRevenue(): number {
    return Math.max(
      0,
      ...(this.collections?.monthlyRevenue.map(item => item.revenue) || [])
    );
  }

  getRevenueBarHeight(revenue: number): number {
    return this.maxMonthlyRevenue > 0
      ? (revenue / this.maxMonthlyRevenue) * 100
      : 0;
  }

  formatCurrency(amount: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 2
    }).format(amount);
  }

  formatCompactCurrency(amount: number): string {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(amount);
  }
}
