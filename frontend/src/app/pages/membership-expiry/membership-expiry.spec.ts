import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { vi } from 'vitest';

import { MembershipExpiry, ExpiringMember } from './membership-expiry';
import { DashboardService } from '../../services/dashboard';
import { MembershipPlanService } from '../../services/membership-plan';

describe('MembershipExpiry', () => {
  let fixture: ComponentFixture<MembershipExpiry>;
  let component: MembershipExpiry;
  let refreshRequested: Subject<void>;
  let dashboard: {
    getMembershipExpiry: ReturnType<typeof vi.fn>;
    requestRefresh: ReturnType<typeof vi.fn>;
  };
  let membershipPlans: {
    getPlans: ReturnType<typeof vi.fn>;
    assignMembership: ReturnType<typeof vi.fn>;
  };

  const member: ExpiringMember = {
    memberId: 'member-1',
    membershipId: 'membership-1',
    fullName: 'Alex Member',
    phone: '+91 98765 43210',
    planName: 'Monthly',
    planId: 'plan-1',
    startDate: '2026-02-01T18:30:00.000Z',
    endDate: '2026-03-01T18:30:00.000Z',
    endDateLocal: '2026-03-02',
    remainingDays: 1,
    status: 'expiringSoon'
  };

  const expiryResponse = {
    success: true,
    timeZone: 'Asia/Kolkata',
    todayDate: '2026-03-01',
    expiringNext7DaysCount: 2,
    expiringTodayCount: 1,
    expiredCount: 3,
    upcomingMembers: [member],
    members: [member],
    pagination: { page: 1, limit: 5, total: 1, totalPages: 1 },
    plans: [{ _id: 'plan-1', planName: 'Monthly' }]
  };

  beforeEach(async () => {
    refreshRequested = new Subject<void>();
    dashboard = {
      getMembershipExpiry: vi.fn().mockReturnValue(of(expiryResponse)),
      requestRefresh: vi.fn()
    };
    membershipPlans = {
      getPlans: vi.fn().mockReturnValue(of({
        plans: [{
          _id: 'plan-1',
          planName: 'Monthly',
          duration: 1,
          durationType: 'Months',
          price: 100,
          status: 'Active'
        }]
      })),
      assignMembership: vi.fn().mockReturnValue(of({
        success: true,
        message: 'Membership assigned successfully'
      }))
    };

    await TestBed.configureTestingModule({
      imports: [MembershipExpiry],
      providers: [
        {
          provide: DashboardService,
          useValue: {
            ...dashboard,
            refreshRequested$: refreshRequested
          }
        },
        { provide: MembershipPlanService, useValue: membershipPlans }
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(MembershipExpiry);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('loads real summary counts and upcoming member records', () => {
    expect(component.expiringNext7DaysCount).toBe(2);
    expect(component.expiringTodayCount).toBe(1);
    expect(component.expiredCount).toBe(3);
    expect(component.upcomingMembers).toEqual([member]);
    expect(dashboard.getMembershipExpiry).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'upcoming', limit: 5 })
    );
  });

  it('builds a properly encoded WhatsApp renewal URL for valid phone numbers', () => {
    const url = component.whatsappUrl(member);
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.hostname).toBe('wa.me');
    expect(parsed.pathname).toBe('/919876543210');
    expect(new URLSearchParams(parsed.search).get('text')).toContain('Alex Member');
    expect(new URLSearchParams(parsed.search).get('text')).toContain('02 Mar 2026');

    expect(component.whatsappUrl({ ...member, phone: 'not a phone' })).toBeNull();
  });

  it('opens the member history view from the profile action', () => {
    const selected = vi.fn();
    component.memberSelected.subscribe(selected);
    component.openMember(member);
    expect(selected).toHaveBeenCalledWith(member);
  });

  it('renews through the existing pending-membership workflow and refreshes the dashboard', () => {
    component.openRenewal(member);
    component.selectedPlanId = 'plan-1';
    component.renewMembership();

    expect(membershipPlans.assignMembership).toHaveBeenCalledWith({
      memberId: 'member-1',
      planId: 'plan-1',
      startDate: '2026-03-03',
      paidAmount: 0
    });
    expect(dashboard.requestRefresh).toHaveBeenCalledOnce();
    expect(component.successMessage).toContain('Membership assigned successfully');

    refreshRequested.next();
    expect(dashboard.getMembershipExpiry).toHaveBeenCalledTimes(2);
  });

  it('loads the complete list with filters and server-side pagination', () => {
    component.openAll();
    component.statusFilter = 'expired';
    component.planFilter = 'plan-1';
    component.onFilterChange();
    component.totalPages = 3;
    component.changePage(1);

    expect(dashboard.getMembershipExpiry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'expired',
        planId: 'plan-1',
        page: 2,
        limit: 10
      })
    );
  });

  it('debounces list search and requests the latest term', async () => {
    component.openAll();
    component.search = 'ale';
    component.onSearchChange();
    component.search = 'alex';
    component.onSearchChange();

    await new Promise(resolve => setTimeout(resolve, 350));

    expect(dashboard.getMembershipExpiry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'all',
        search: 'alex',
        page: 1
      })
    );
  });
});
