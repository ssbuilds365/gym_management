
import { ChangeDetectorRef, Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { filter, finalize, Subscription } from 'rxjs';
import { jsPDF } from 'jspdf';

import { AuthService } from './services/auth';
import { DashboardService } from './services/dashboard';
import { AttendanceService } from './services/attendance';

import { Members } from './pages/members/members';
import { MembershipPlans } from './pages/membership-plans/membership-plans';
import { Attendance } from './pages/attendance/attendance';
import { Payments } from './pages/payments/payments';
import { TrainersStaff } from './pages/trainers-staff/trainers-staff';
import { Reports } from './pages/reports/reports';
import { BusinessSettings } from './pages/settings/settings';
import { ExpiringMember, MembershipExpiry } from './pages/membership-expiry/membership-expiry';
import { ExpenseTracker } from './pages/expenses/expense-tracker';
import { Enquiries } from './pages/enquiries/enquiries';
import { GlobalMessage } from './pages/global-message/global-message';
import { DatabaseStorage } from './pages/database-storage/database-storage';
import { SessionActivityService } from './services/session-activity';
import { PersonalTrainerDashboard } from './pages/personal-trainer-dashboard/personal-trainer-dashboard';
import { PersonalTrainerSessions } from './pages/personal-trainer-sessions/personal-trainer-sessions';
import { PersonalTrainerNotes } from './pages/personal-trainer-notes/personal-trainer-notes';

import { environment } from '../environments/environment';

export const isAttendanceKioskUrl = (url: string): boolean =>
  /^\/attendance-kiosk(?:\/|[?#]|$)/.test(url);

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
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
    Enquiries,
    GlobalMessage,
    DatabaseStorage,
    PersonalTrainerDashboard,
    PersonalTrainerSessions,
    PersonalTrainerNotes
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
  businessType = 'Gym';
  businessLogoUrl = '';
  ownerName = 'Admin';

  stats: any[] = [];
  recentMembers: any[] = [];
  birthdayMembers: Array<{ _id: string; fullName: string; phone: string; age: number | null }> = [];
  birthdayCount = 0;
  birthdaysLoading = false;
  birthdaysError = '';
  birthdayActionError = '';
  memberToFocus: ExpiringMember | null = null;
  memberRegistrationRequest: any = null;
  memberConversionSubmission: any = null;
  memberConversionResult: any = null;
  readonly dashboardStatPlaceholders = [0, 1, 2, 3, 4];

  dashboardLoading = false;
  dashboardError = '';
  expiringPTClients: any[] = [];
  expiringPTCount = 0;
  expiringPTPanelOpen = false;
  todayAttendance = 0;
  dashboardTimeZone = 'Asia/Kolkata';
  attendanceSearchType: 'Member' | 'Staff' | 'Trainer' = 'Member';
  attendanceSearchQuery = '';
  attendanceSearchLoading = false;
  attendanceSearchError = '';
  attendanceSelectedPerson: any = null;
  attendanceReportMonth = new Date().getMonth() + 1;
  attendanceReportYear = new Date().getFullYear();
  attendanceReportLoading = false;
  attendanceReportError = '';
  attendanceReport: any = null;
  attendanceSelectedDate: any = null;
  attendanceExportLoading = false;
  readonly attendanceWeekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
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
  private birthdaysRequest?: Subscription;
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
        { name: 'Enquiry Management', icon: '◎' },
        { name: 'Global Message', icon: '◉' },
        { name: 'Trainers', icon: '♟' },
        { name: 'Staff', icon: '♙' },
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

  configureNavigation(businessType: string): void {
    this.businessType = businessType === 'Personal Trainer' ? 'Personal Trainer' : 'Gym';
    if (this.businessType === 'Personal Trainer') {
      this.menuGroups = [
        {
          title: 'MAIN MENU',
          items: [
            { name: 'Dashboard', icon: '⌂' },
            { name: 'Members', icon: '♙' },
            { name: 'Attendance', icon: '◷' },
            { name: 'Payments & Fees', icon: '₹' }
          ]
        },
        {
          title: 'MANAGEMENT',
          items: [
            { name: 'Expense Tracker', icon: '₹' },
            { name: 'Enquiry Management', icon: '◎' },
            { name: 'Global Message', icon: '◉' },
            { name: 'Upcoming Sessions', icon: '◷' },
            { name: 'Notes', icon: '▤' },
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
      return;
    }
    this.menuGroups = [
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
          { name: 'Enquiry Management', icon: '◎' },
          { name: 'Global Message', icon: '◉' },
          { name: 'Trainers', icon: '♟' },
          { name: 'Staff', icon: '♙' },
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
  }

  constructor(
    private router: Router,
    private authService: AuthService,
    private dashboardService: DashboardService,
    private attendanceService: AttendanceService,
    private changeDetector: ChangeDetectorRef,
    private sessionActivity: SessionActivityService
  ) {}

  ngOnInit(): void {
    this.dashboardRefreshSubscription = this.dashboardService.refreshRequested$
      .subscribe(() => {
        if (!this.isAuthenticated) return;
        if (this.selectedMenu === 'Dashboard') {
          if (this.businessType === 'Personal Trainer') return;
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
    this.birthdaysRequest?.unsubscribe();
    this.sessionWarningSubscription?.unsubscribe();
    this.sessionRemainingSubscription?.unsubscribe();
    this.sessionExpiredSubscription?.unsubscribe();
    this.sessionActivity.stop();
    window.removeEventListener('storage', this.sessionReferenceHandler);
  }

  // SESSION VERIFICATION
  verifySession(): void {
    const currentUrl = isAttendanceKioskUrl(window.location.pathname)
      ? window.location.pathname
      : this.router.url;
    if (
      currentUrl.startsWith('/login') ||
      currentUrl.startsWith('/register') ||
      currentUrl.startsWith('/forgot-password') ||
      currentUrl.startsWith('/reset-password') ||
      isAttendanceKioskUrl(currentUrl)
    ) {
      this.sessionChecking = false;
      this.sessionVerificationError = '';
      this.sessionActivity.stop();
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
          if (this.isAttendanceKioskRoute()) return;
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
              this.birthdayMembers = [];
              this.birthdayCount = 0;
              this.birthdaysError = '';
              this.dashboardLoadedAt = 0;
            }

            this.ownerName = response.owner.name || 'Owner';
            this.businessName = response.business.businessName || this.appName;
            this.businessLogoUrl = response.business.logoUrl || '';
            this.configureNavigation(response.business.businessType || 'Gym');
            this.selectedMenu = currentUrl.startsWith('/members') ? 'Members' : 'Dashboard';
            if (this.businessType !== 'Personal Trainer') this.loadDashboardData();
          } else {
            this.handleInvalidSession('revoked');
          }
        },
        error: (error) => {
          if (this.isAttendanceKioskRoute()) return;
          console.error('Session verification failed:', {
            status: error.status,
            code: error.error?.code
          });
          if (error.status === 401) {
            const reason = error.error?.code === 'SESSION_EXPIRED' ? 'expired'
              : error.error?.code === 'SESSION_REVOKED' ? 'revoked'
                : error.error?.code === 'SESSION_REQUIRED' ||
                  error.error?.code === 'SESSION_INVALID' ? 'required'
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
    const currentUrl = isAttendanceKioskUrl(window.location.pathname)
      ? window.location.pathname
      : this.router.url;
    return (
      currentUrl.startsWith('/register') ||
      currentUrl.startsWith('/login') ||
      currentUrl.startsWith('/forgot-password') ||
      currentUrl.startsWith('/reset-password') ||
      isAttendanceKioskUrl(currentUrl)
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
    this.birthdayMembers = [];
    this.birthdayCount = 0;
    this.birthdaysError = '';
    this.dashboardError = '';
    this.todayAttendance = 0;
    this.dashboardTimeZone = 'Asia/Kolkata';
    this.collections = null;

    this.ownerName = 'Admin';
    this.businessName = this.appName;
    this.businessLogoUrl = '';
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
    if (this.isAttendanceKioskRoute()) {
      this.sessionActivity.stop();
      return;
    }
    this.handleInvalidSession(reason);
  }

  private isAttendanceKioskRoute(): boolean {
    return isAttendanceKioskUrl(window.location.pathname) ||
      isAttendanceKioskUrl(this.router.url);
  }

  // SIDEBAR MENU
  selectMenu(name: string): void {
    if (
      this.businessType === 'Personal Trainer' &&
      ['Membership Plans', 'Trainers', 'Staff'].includes(name)
    ) return;

    if (name !== 'Members') this.memberToFocus = null;
    this.selectedMenu = name;
    this.mobileMenuOpen = false;

    if (name === 'Dashboard') {
      if (this.businessType !== 'Personal Trainer') this.loadDashboardData(true);
    }
  }

  openMemberFromExpiry(member: ExpiringMember): void {
    this.memberToFocus = member;
    this.selectMenu('Members');
  }

  requestMemberRegistration(request: any): void {
    this.memberConversionResult = null;
    this.memberConversionSubmission = null;
    this.memberRegistrationRequest = request;
    this.selectMenu('Members');
  }

  submitMemberConversion(submission: any): void {
    this.memberConversionResult = null;
    this.memberConversionSubmission = submission;
    this.selectMenu('Enquiry Management');
  }

  onMemberConversionCompleted(result: any): void {
    this.memberConversionSubmission = null;
    this.memberConversionResult = result;
    if (!result?.error) {
      this.memberRegistrationRequest = null;
    }
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
    if (this.businessType === 'Personal Trainer') {
      return;
    }

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
    this.loadTodaysBirthdays();

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
          this.expiringPTClients = Array.isArray(response.expiringPTClients)
            ? response.expiringPTClients
            : [];
          this.expiringPTCount = Number(data.expiringPTClients || this.expiringPTClients.length);

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
            },
            {
              title: 'Expiring Personal Training Clients',
              value: this.expiringPTCount.toLocaleString('en-IN'),
              change: '',
              description: 'Next 5 Days',
              icon: '⚠',
              color: 'red',
              action: 'expiringPT'
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

  private loadTodaysBirthdays(): void {
    this.birthdaysRequest?.unsubscribe();
    this.birthdaysLoading = true;
    this.birthdaysError = '';
    this.birthdaysRequest = this.dashboardService.getTodaysBirthdays()
      .pipe(finalize(() => {
        this.birthdaysLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          if (!response?.success || !Array.isArray(response.members)) {
            this.birthdaysError = 'Unable to load today’s birthdays.';
            this.birthdayMembers = [];
            this.birthdayCount = 0;
            return;
          }
          this.birthdayMembers = response.members.map((member: any) => ({
            _id: String(member._id),
            fullName: String(member.fullName || 'Member'),
            phone: String(member.phone || '—'),
            age: Number.isInteger(member.age) && member.age >= 0 ? member.age : null
          }));
          this.birthdayCount = Number(response.count) || this.birthdayMembers.length;
        },
        error: error => {
          console.error('Dashboard birthdays loading error:', error);
          this.birthdaysError = error.error?.message || 'Unable to load today’s birthdays.';
          this.birthdayMembers = [];
          this.birthdayCount = 0;
        }
      });
  }

  sendBirthdayWhatsApp(member: { fullName: string; phone: string }): void {
    this.birthdayActionError = '';
    const digits = String(member.phone || '').replace(/\D/g, '');
    let internationalNumber = '';
    if (/^[6-9]\d{9}$/.test(digits)) {
      internationalNumber = `91${digits}`;
    } else if (/^91[6-9]\d{9}$/.test(digits)) {
      internationalNumber = digits;
    }

    if (!internationalNumber) {
      this.birthdayActionError = 'This member does not have a valid WhatsApp mobile number.';
      return;
    }

    const message = `🎉 Happy Birthday, ${member.fullName}! 🎂

Wishing you a fantastic birthday filled with happiness, good health, and success!

Keep staying active, keep working towards your fitness goals, and keep getting stronger every day. 💪🔥

Your SS Fitness Manager family wishes you an amazing year ahead!

Stay Fit. Stay Strong. ❤️

– Team SS Builds`;
    const url = `https://wa.me/${internationalNumber}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
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

  searchAttendancePerson(): void {
    const query = this.attendanceSearchQuery.trim();
    if (!query) {
      this.attendanceSearchError = 'Enter a member, staff or trainer ID or contact number.';
      return;
    }
    this.attendanceSearchLoading = true;
    this.attendanceSearchError = '';
    this.attendanceSelectedPerson = null;
    this.attendanceReport = null;
    this.attendanceSelectedDate = null;
    this.attendanceService.searchPerson(this.attendanceSearchType, query).subscribe({
      next: response => {
        this.attendanceSearchLoading = false;
        if (!response?.success) {
          this.attendanceSearchError = 'No matching person found.';
          return;
        }
        this.attendanceSelectedPerson = response.person;
        this.loadAttendanceReport();
      },
      error: error => {
        this.attendanceSearchLoading = false;
        this.attendanceSearchError = error.error?.message || 'Unable to search person.';
        this.changeDetector.markForCheck();
      }
    });
  }

  loadAttendanceReport(): void {
    if (!this.attendanceSelectedPerson) return;
    this.attendanceReportLoading = true;
    this.attendanceReportError = '';
    this.attendanceSelectedDate = null;
    this.attendanceService.getMonthlyReport(
      this.attendanceSearchType,
      this.attendanceSelectedPerson.id,
      this.attendanceReportMonth,
      this.attendanceReportYear
    ).subscribe({
      next: response => {
        this.attendanceReportLoading = false;
        this.attendanceReport = response;
        this.changeDetector.markForCheck();
      },
      error: error => {
        this.attendanceReportLoading = false;
        this.attendanceReportError = error.error?.message || 'Unable to load attendance report.';
        this.changeDetector.markForCheck();
      }
    });
  }

  changeAttendanceMonth(offset: number): void {
    const date = new Date(this.attendanceReportYear, this.attendanceReportMonth - 1 + offset, 1);
    this.attendanceReportMonth = date.getMonth() + 1;
    this.attendanceReportYear = date.getFullYear();
    this.loadAttendanceReport();
  }

  setCurrentAttendanceMonth(): void {
    const now = new Date();
    this.attendanceReportMonth = now.getMonth() + 1;
    this.attendanceReportYear = now.getFullYear();
    this.loadAttendanceReport();
  }

  selectAttendanceDate(row: any): void {
    this.attendanceSelectedDate = row;
  }

  getAttendanceMonthDays(): any[] {
    if (!this.attendanceReport) return [];
    return this.attendanceReport.daily || [];
  }

  getAttendanceCalendarCells(): Array<any | null> {
    const days = this.getAttendanceMonthDays();
    if (!days.length) return [];
    const year = this.attendanceReportYear;
    const month = this.attendanceReportMonth;
    const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
    const cells: Array<any | null> = Array(firstWeekday).fill(null);
    cells.push(...days);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }

  getAttendanceStatusClass(status: string): string {
    switch (status) {
      case 'Present': return 'status-present';
      case 'Absent': return 'status-absent';
      case 'Approved Leave': return 'status-leave';
      case 'Half Day': return 'status-half';
      case 'Weekly Off': return 'status-weekly';
      case 'Public Holiday': return 'status-holiday';
      default: return 'status-future';
    }
  }

  private async generatePremiumAttendancePdf(): Promise<void> {
    if (!this.attendanceReport || !this.attendanceSelectedPerson) return;
    const report = this.attendanceReport;
    const summary = report.summary;
    const person = report.person;
    const gym = report.gymDetails || {};
    const monthName = new Intl.DateTimeFormat('en-IN', { month: 'long' })
      .format(new Date(report.year, report.month - 1, 1));
    const generatedAt = new Date();
    const generatedLabel = generatedAt.toLocaleString('en-IN');
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 14;
    const red: [number, number, number] = [227, 57, 53];
    const dark: [number, number, number] = [35, 38, 51];
    const muted: [number, number, number] = [112, 117, 130];
    const light: [number, number, number] = [246, 247, 249];

    pdf.setFillColor(...red);
    pdf.rect(0, 0, pageWidth, 24, 'F');

    let logoAdded = false;
    if (gym.logoUrl) {
      try {
        const response = await fetch(gym.logoUrl);
        if (response.ok) {
          const blob = await response.blob();
          const reader = new FileReader();
          const dataUrl = await new Promise<string>((resolve, reject) => {
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error('Logo could not be read'));
            reader.readAsDataURL(blob);
          });
          pdf.addImage(dataUrl, 'AUTO', margin, 4, 16, 16);
          logoAdded = true;
        }
      } catch {
        logoAdded = false;
      }
    }

    const brandX = logoAdded ? margin + 20 : margin;
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(13);
    pdf.text('SS FITNESS', brandX, 11);
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.text('MANAGER PRO', brandX, 16);
    pdf.setFontSize(15);
    pdf.setFont('helvetica', 'bold');
    pdf.text('MONTHLY ATTENDANCE REPORT', pageWidth - margin, 12, { align: 'right' });
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`${monthName} ${report.year}`, pageWidth - margin, 18, { align: 'right' });

    let y = 31;
    pdf.setTextColor(...dark);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text('PERSON DETAILS', margin, y);
    pdf.text('GYM DETAILS', 116, y);
    y += 5;
    pdf.setDrawColor(220, 222, 228);
    pdf.setFillColor(255, 255, 255);
    pdf.roundedRect(margin, y, 88, 34, 2, 2, 'FD');
    pdf.roundedRect(116, y, pageWidth - margin - 116, 34, 2, 2, 'FD');

    pdf.setTextColor(...dark);
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'bold');
    const personNameLines = pdf.splitTextToSize(person.name || 'Person', 82);
    pdf.text(personNameLines.slice(0, 2), margin + 4, y + 8);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...muted);
    let personDetailY = y + 16;
    pdf.text(`${person.type} · ${person.publicId || 'ID unavailable'}`, margin + 4, personDetailY);
    personDetailY += 5;
    if (person.contactNumber) {
      pdf.text(`Contact: ${person.contactNumber}`, margin + 4, personDetailY);
      personDetailY += 5;
    }
    if (person.designation) {
      pdf.text(`Designation: ${person.designation}`, margin + 4, personDetailY);
    } else if (person.specialization) {
      pdf.text(`Specialization: ${person.specialization}`, margin + 4, personDetailY);
    }

    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(...dark);
    pdf.setFontSize(9);
    const gymNameLines = pdf.splitTextToSize(report.businessName || 'SS Fitness Manager', 70);
    pdf.text(gymNameLines.slice(0, 2), 120, y + 8);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...muted);
    let gymDetailY = y + 16;
    if (gym.address) {
      const addressLines = pdf.splitTextToSize(`Address: ${gym.address}`, 72);
      pdf.text(addressLines.slice(0, 2), 120, gymDetailY);
      gymDetailY += addressLines.length > 1 ? 9 : 5;
    }
    if (gym.phone) {
      pdf.text(`Phone: ${gym.phone}`, 120, gymDetailY);
      gymDetailY += 5;
    }
    if (gym.email) pdf.text(`Email: ${gym.email}`, 120, gymDetailY);

    y += 41;
    pdf.setTextColor(...dark);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text('ATTENDANCE SUMMARY', margin, y);
    y += 5;

    const cards = [
      ['Present Days', String(summary.presentDays)],
      ['Absent Days', String(summary.absentDays)],
      ['Total Working Days', String(summary.totalWorkingDays)],
      ['Attendance %', `${summary.attendancePercentage}%`],
      ['Total Working Hours', summary.totalWorkingHours == null ? 'Unavailable' : String(summary.totalWorkingHours)]
    ];
    const cardGap = 3;
    const cardWidth = (pageWidth - margin * 2 - cardGap * 4) / 5;
    cards.forEach((card, index) => {
      const x = margin + index * (cardWidth + cardGap);
      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(225, 227, 232);
      pdf.roundedRect(x, y, cardWidth, 21, 2, 2, 'FD');
      pdf.setFillColor(...red);
      pdf.rect(x, y, 2, 21, 'F');
      pdf.setTextColor(...muted);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(6.8);
      const labelLines = pdf.splitTextToSize(card[0], cardWidth - 6);
      pdf.text(labelLines.slice(0, 2), x + 5, y + 7);
      pdf.setTextColor(...dark);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(12);
      pdf.text(card[1], x + 5, y + 16);
    });

    y += 27;
    pdf.setTextColor(...dark);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text('MONTHLY ATTENDANCE CALENDAR', margin, y);
    y += 5;

    const calendarX = margin;
    const calendarWidth = pageWidth - margin * 2;
    const cellWidth = calendarWidth / 7;
    const headerHeight = 8;
    const cellHeight = 13;
    pdf.setFillColor(35, 38, 51);
    pdf.rect(calendarX, y, calendarWidth, headerHeight, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7);
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((weekday, index) => {
      pdf.text(weekday, calendarX + index * cellWidth + cellWidth / 2, y + 5.2, { align: 'center' });
    });
    y += headerHeight;

    const cells = this.getAttendanceCalendarCells();
    cells.forEach((day, index) => {
      const row = Math.floor(index / 7);
      const col = index % 7;
      const x = calendarX + col * cellWidth;
      const cy = y + row * cellHeight;
      let fill: [number, number, number] = [248, 248, 250];
      let textColor: [number, number, number] = [120, 123, 132];
      if (day) {
        switch (day.status) {
          case 'Present': fill = [224, 244, 232]; textColor = [24, 136, 74]; break;
          case 'Absent': fill = [253, 234, 234]; textColor = [198, 40, 40]; break;
          case 'Approved Leave': fill = [255, 247, 201]; textColor = [138, 116, 23]; break;
          case 'Half Day': fill = [255, 240, 223]; textColor = [179, 106, 25]; break;
          case 'Weekly Off': fill = [231, 240, 255]; textColor = [53, 106, 181]; break;
          case 'Public Holiday': fill = [242, 234, 253]; textColor = [116, 81, 165]; break;
          default: fill = [241, 242, 244]; textColor = [141, 145, 155];
        }
      }
      pdf.setFillColor(...fill);
      pdf.setDrawColor(225, 227, 232);
      pdf.rect(x, cy, cellWidth, cellHeight, 'FD');
      if (day) {
        pdf.setTextColor(...textColor);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(8);
        pdf.text(day.date.slice(-2), x + 2.5, cy + 4.5);
        pdf.setFontSize(6);
        const shortStatus = day.status === 'Present' ? 'Present'
          : day.status === 'Absent' ? 'Absent'
          : day.status === 'Approved Leave' ? 'Leave'
          : day.status === 'Half Day' ? 'Half Day'
          : day.status === 'Weekly Off' ? 'Off'
          : day.status === 'Public Holiday' ? 'Holiday'
          : '—';
        pdf.text(shortStatus, x + cellWidth - 2, cy + 10.5, { align: 'right' });
      }
    });
    y += Math.ceil(cells.length / 7) * cellHeight + 5;

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(6.8);
    pdf.setTextColor(...muted);
    pdf.text('Legend: ', margin, y);
    const legend = [
      ['Present', [224, 244, 232], [24, 136, 74]],
      ['Absent', [253, 234, 234], [198, 40, 40]],
      ['Leave', [255, 247, 201], [138, 116, 23]],
      ['Off', [231, 240, 255], [53, 106, 181]],
      ['Holiday', [242, 234, 253], [116, 81, 165]]
    ] as Array<[string, [number, number, number], [number, number, number]]>;
    let legendX = margin + 14;
    legend.forEach(item => {
      pdf.setFillColor(...item[1]);
      pdf.roundedRect(legendX, y - 3, 3, 3, 0.5, 0.5, 'F');
      pdf.setTextColor(...item[2]);
      pdf.text(item[0], legendX + 4, y);
      legendX += 20;
    });

    y += 8;
    pdf.setDrawColor(220, 222, 228);
    pdf.roundedRect(margin, y, pageWidth - margin * 2, 18, 2, 2, 'D');
    pdf.setTextColor(...dark);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.text('REPORT DETAILS', margin + 4, y + 5);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(...muted);
    const totalDaysInMonth = new Date(report.year, report.month, 0).getDate();
    const detailText = `Month: ${monthName} ${report.year}  |  Type: ${person.type}  |  ID: ${person.publicId || 'Unavailable'}  |  Total Days: ${totalDaysInMonth}`;
    pdf.text(detailText, margin + 4, y + 10);
    const secondDetail = `Working Days: ${summary.totalWorkingDays}  |  Present: ${summary.presentDays}  |  Absent: ${summary.absentDays}  |  Attendance: ${summary.attendancePercentage}%  |  Working Hours: ${summary.totalWorkingHours ?? 'Unavailable'}`;
    pdf.text(secondDetail, margin + 4, y + 15);

    y += 23;
    pdf.setTextColor(...dark);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.text('FORMULA & NOTES', margin, y);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(6.8);
    pdf.setTextColor(...muted);
    const notes = [
      report.formula,
      'Attendance is based on recorded attendance data. Existing sources may include Manual, QR and Biometric.',
      'Working hours are calculated only from valid check-in/check-out records.',
      'Report generated by SS Fitness Manager Pro.'
    ];
    let noteY = y + 5;
    notes.forEach(note => {
      const lines = pdf.splitTextToSize(note, pageWidth - margin * 2);
      pdf.text(lines, margin, noteY);
      noteY += lines.length * 3.5 + 1;
    });

    const pageCount = pdf.getNumberOfPages();
    for (let page = 1; page <= pageCount; page++) {
      pdf.setPage(page);
      pdf.setDrawColor(225, 227, 232);
      pdf.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.setTextColor(...muted);
      pdf.text(`Generated ${generatedLabel}`, margin, pageHeight - 7);
      pdf.text('SS Fitness Manager Pro', pageWidth - margin, pageHeight - 7, { align: 'right' });
      pdf.text(`Page ${page} of ${pageCount}`, pageWidth / 2, pageHeight - 7, { align: 'center' });
    }

    const identifier = (person.publicId || 'person').replace(/[^A-Za-z0-9_-]/g, '_');
    const personType = person.type || 'Person';
    pdf.save(`SSFitness_Attendance_${personType}_${identifier}_${monthName}_${report.year}.pdf`);
  }

  downloadAttendanceReport(format: 'pdf' | 'xlsx' | 'csv'): void {
    if (!this.attendanceSelectedPerson || this.attendanceExportLoading) return;
    this.attendanceExportLoading = true;
    if (format === 'pdf') {
      this.generatePremiumAttendancePdf();
      this.attendanceExportLoading = false;
      return;
    }
    this.attendanceService.getMonthlyReportDownload(
      this.attendanceSearchType,
      this.attendanceSelectedPerson.id,
      this.attendanceReportMonth,
      this.attendanceReportYear,
      format
    ).subscribe({
      next: blob => {
        this.attendanceExportLoading = false;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `attendance-${this.attendanceSelectedPerson.publicId || 'person'}-${this.attendanceReportYear}-${String(this.attendanceReportMonth).padStart(2, '0')}.${format}`;
        link.click();
        URL.revokeObjectURL(url);
      },
      error: () => {
        this.attendanceExportLoading = false;
        this.attendanceReportError = 'Unable to download the selected report.';
        this.changeDetector.markForCheck();
      }
    });
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
