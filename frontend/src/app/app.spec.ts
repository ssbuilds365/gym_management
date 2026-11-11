import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BehaviorSubject, of, Subject } from 'rxjs';
import { App } from './app';
import { AuthService } from './services/auth';
import { DashboardService } from './services/dashboard';
import { SessionActivityService } from './services/session-activity';
import { MembershipPlanService } from './services/membership-plan';

describe('App', () => {
  let windowOpen: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            getSessionReference: () => '',
            getProfile: () => of({
              success: true,
              owner: { name: 'Owner' },
              business: { businessName: 'Test Gym' },
              session: {
                id: 'session-1',
                lastActivityAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString()
              }
            })
          }
        },
        {
          provide: DashboardService,
          useValue: {
            refreshRequested$: new Subject<void>(),
            getDashboardStats: () => of({ success: true, stats: {} }),
            getTodaysBirthdays: () => of({ success: true, count: 0, members: [] }),
            getMembershipExpiry: () => of({
              success: true,
              expiringNext7DaysCount: 0,
              expiringTodayCount: 0,
              expiredCount: 0,
              upcomingMembers: [],
              members: [],
              pagination: { total: 0, totalPages: 0 },
              plans: []
            })
          }
        },
        {
          provide: MembershipPlanService,
          useValue: {
            getPlans: () => of({ plans: [] }),
            assignMembership: () => of({ success: true })
          }
        },
        {
          provide: SessionActivityService,
          useValue: {
            warning$: new BehaviorSubject(false),
            remainingMs$: new BehaviorSubject(30 * 60 * 1000),
            sessionExpired$: new Subject(),
            start: vi.fn(),
            stop: vi.fn(),
            stayLoggedIn: vi.fn()
          }
        }
      ]
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should show the dashboard after verifying the session', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('Dashboard');
  });

  it('keeps only Settings and Database Storage in System navigation', () => {
    const fixture = TestBed.createComponent(App);
    const systemGroup = fixture.componentInstance.menuGroups.find(group => group.title === 'SYSTEM');

    expect(systemGroup?.items.map(item => item.name)).toEqual(['Settings', 'Database Storage']);
  });

  it('places Global Message directly below Enquiry Management in Management navigation', () => {
    const fixture = TestBed.createComponent(App);
    const managementGroup = fixture.componentInstance.menuGroups.find(group => group.title === 'MANAGEMENT');

    expect(managementGroup?.items.map(item => item.name)).toEqual([
      'Expense Tracker',
      'Enquiry Management',
      'Global Message',
      'Trainers & Staff',
      'Reports & Analytics'
    ]);
  });

  it('does not render owner subscription status or view-subscription links', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Subscription Status');
    expect(fixture.nativeElement.textContent).not.toContain('View Subscription');
  });

  it('opens WhatsApp with a personalized message for a valid Indian number', () => {
    const fixture = TestBed.createComponent(App);
    const member = { fullName: "Asha O'Neil & Co.", phone: '98765-43210' };

    fixture.componentInstance.sendBirthdayWhatsApp(member);

    const [url, target] = windowOpen.mock.calls[0];
    expect(target).toBe('_blank');
    expect(url).toContain('https://wa.me/919876543210?text=');
    const message = decodeURIComponent(String(url).split('?text=')[1]);
    expect(message).toContain("Happy Birthday, Asha O'Neil & Co.!");
    expect(message).toContain('Stay Fit. Stay Strong.');
  });

  it('normalizes +91 and 91 phone formats without duplicating the country code', () => {
    const fixture = TestBed.createComponent(App);

    fixture.componentInstance.sendBirthdayWhatsApp({ fullName: 'Member One', phone: '+91 (98765) 43210' });
    fixture.componentInstance.sendBirthdayWhatsApp({ fullName: 'Member Two', phone: '91-98765-43210' });

    expect(windowOpen.mock.calls[0][0]).toContain('https://wa.me/919876543210?');
    expect(windowOpen.mock.calls[1][0]).toContain('https://wa.me/919876543210?');
  });

  it('does not open WhatsApp for missing or invalid mobile numbers', () => {
    const fixture = TestBed.createComponent(App);
    windowOpen.mockClear();

    fixture.componentInstance.sendBirthdayWhatsApp({ fullName: 'Member One', phone: '' });
    expect(fixture.componentInstance.birthdayActionError)
      .toBe('This member does not have a valid WhatsApp mobile number.');
    fixture.componentInstance.sendBirthdayWhatsApp({ fullName: 'Member Two', phone: '12345' });

    expect(windowOpen).not.toHaveBeenCalled();
    expect(fixture.componentInstance.birthdayActionError)
      .toBe('This member does not have a valid WhatsApp mobile number.');
  });
});
