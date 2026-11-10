import { SimpleChange } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { Enquiries } from './enquiries';
import { EnquiryService } from '../../services/enquiry';
import { MembershipPlanService } from '../../services/membership-plan';
import { ManagementService } from '../../services/management';

describe('Enquiries', () => {
  let component: Enquiries;
  let fixture: ComponentFixture<Enquiries>;
  let service: {
    list: ReturnType<typeof vi.fn>;
    dashboard: ReturnType<typeof vi.fn>;
    analytics: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    addFollowUp: ReturnType<typeof vi.fn>;
    addTrial: ReturnType<typeof vi.fn>;
    convert: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      list: vi.fn().mockReturnValue(of({
        enquiries: [],
        pagination: { total: 0, totalPages: 0 }
      })),
      dashboard: vi.fn().mockReturnValue(of({ dashboard: {
        total: 0, converted: 0, conversionRate: 0, dueFollowUps: 0, statusCounts: {}
      } })),
      analytics: vi.fn().mockReturnValue(of({ analytics: {} })),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      updateStatus: vi.fn(),
      addFollowUp: vi.fn(),
      addTrial: vi.fn(),
      convert: vi.fn()
    };
    await TestBed.configureTestingModule({
      imports: [Enquiries],
      providers: [
        { provide: EnquiryService, useValue: service },
        { provide: MembershipPlanService, useValue: { getPlans: () => of({ plans: [] }) } },
        { provide: ManagementService, useValue: { getStaff: () => of({ staff: [] }) } }
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(Enquiries);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('loads dashboard and page one with backend pagination parameters', () => {
    expect(service.list).toHaveBeenCalledWith({
      search: '',
      status: '',
      source: '',
      assignedStaffId: '',
      from: '',
      to: '',
      page: 1,
      limit: 10
    });
    expect(component.loading).toBe(false);
    expect(component.total).toBe(0);
  });

  it('passes source, assigned staff, and date filters to the paginated API query', () => {
    component.search = 'Asha';
    component.statusFilter = 'INTERESTED';
    component.sourceFilter = 'Referral';
    component.assignedStaffFilter = 'staff-1';
    component.fromDate = '2026-10-01';
    component.toDate = '2026-10-31';

    component.applyFilters();

    expect(service.list).toHaveBeenLastCalledWith({
      search: 'Asha',
      status: 'INTERESTED',
      source: 'Referral',
      assignedStaffId: 'staff-1',
      from: '2026-10-01',
      to: '2026-10-31',
      page: 1,
      limit: 10
    });
  });

  it('retains the enquiry form and displays duplicate-mobile responses', () => {
    service.create.mockReturnValue(throwError(() => ({
      status: 409,
      error: {
        message: 'An enquiry with this mobile number already exists.',
        existingEnquiryId: 'existing-1'
      }
    })));
    component.openCreateForm();
    component.enquiryForm.fullName = 'Asha';
    component.enquiryForm.phone = '9876543210';

    component.saveEnquiry();

    expect(component.showForm).toBe(true);
    expect(component.duplicateMessage).toContain('already exists');
    expect(component.duplicateEnquiryId).toBe('existing-1');
    expect(component.enquiryForm.fullName).toBe('Asha');
  });

  it('normalizes Indian mobile numbers and creates a gender-aware WhatsApp link', () => {
    const url = component.whatsappUrl({
      _id: 'enquiry-1',
      fullName: 'Asha Rao',
      phone: '+91 (98765) 43210',
      gender: 'Female',
      status: 'NEW' as const
    });

    expect(url).toContain('https://wa.me/919876543210?text=');
    const message = decodeURIComponent(url.split('?text=')[1]);
    expect(message).toContain("Hello Asha Rao Ma'am,");
    expect(message).toContain('Regards,\nTeam SS Builds');
    expect(message).toContain('a convenient time when we can call you');
    expect(component.phoneUrl('98765-43210')).toBe('tel:+919876543210');
    expect(decodeURIComponent(component.whatsappUrl({
      _id: 'enquiry-2',
      fullName: 'Arjun',
      phone: '9876543210',
      gender: 'Male',
      status: 'NEW'
    }).split('?text=')[1])).toContain('Hello Arjun Sir,');
  });

  it('requests registration through the existing member-registration flow', () => {
    const requested = vi.fn();
    component.memberRegistrationRequested.subscribe(requested);
    const prospect = {
      _id: 'enquiry-1',
      fullName: 'Sam',
      phone: '9876543210',
      email: 'sam@example.com',
      gender: 'Other',
      status: 'INTERESTED' as const,
      notes: 'Prefers evening sessions'
    };

    component.startConversion(prospect as any);

    expect(requested).toHaveBeenCalledWith(expect.objectContaining({
      enquiry: expect.objectContaining({ fullName: 'Sam', phone: '9876543210' })
    }));
    expect(service.convert).not.toHaveBeenCalled();
  });

  it('uses the existing Members form and sends conversion details to the backend contract', () => {
    const prospect = {
      _id: 'enquiry-1',
      fullName: 'Sam',
      phone: '9876543210',
      email: 'sam@example.com',
      gender: 'Other',
      status: 'INTERESTED'
    };
    component.selectedEnquiry = prospect as any;
    let request: any;
    component.memberRegistrationRequested.subscribe(value => request = value);
    component.startConversion(prospect as any);

    expect(request.enquiryId).toBe('enquiry-1');
    expect(request.enquiry).toMatchObject({
      fullName: 'Sam',
      phone: '9876543210',
      email: 'sam@example.com',
      gender: 'Other'
    });
    expect(service.convert).not.toHaveBeenCalled();

    service.convert.mockReturnValue(of({
      message: 'Enquiry converted to member successfully',
      member: { _id: 'member-1' },
      enquiry: { ...prospect, status: 'CONVERTED' }
    }));
    const completed = vi.fn();
    component.memberConversionCompleted.subscribe(completed);
    component.memberConversionSubmission = {
      requestId: request.requestId,
      attemptId: `${request.requestId}-1`,
      enquiryId: 'enquiry-1',
      planId: 'plan-1',
      membershipStartDate: '2026-11-10',
      payload: {
        email: 'sam@example.com',
        gender: 'Other',
        dateOfBirth: null,
        joiningDate: '2026-11-10',
        notes: ''
      }
    };
    component.ngOnChanges({
      memberConversionSubmission: new SimpleChange(null, component.memberConversionSubmission, false)
    });

    expect(service.convert).toHaveBeenCalledWith('enquiry-1', expect.objectContaining({
      email: 'sam@example.com',
      dateOfBirth: null,
      joiningDate: '2026-11-10'
    }));
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.requestId,
      member: { _id: 'member-1' },
      planId: 'plan-1'
    }));
    expect(component.successMessage).toContain('converted to member successfully');
  });

  it('uses canonical status values and exposes all nine summary metrics', () => {
    expect(component.statuses).toEqual([
      'NEW', 'CONTACTED', 'INTERESTED', 'TRIAL_SCHEDULED', 'FOLLOW_UP', 'CONVERTED', 'LOST'
    ]);
    component.dashboard = {
      total: 10,
      converted: 2,
      conversionRate: 20,
      dueFollowUps: 1,
      followUpsToday: 4,
      overdueFollowUps: 2,
      statusCounts: { NEW: 3, CONTACTED: 1, INTERESTED: 1, TRIAL_SCHEDULED: 1, FOLLOW_UP: 1, CONVERTED: 2, LOST: 1 }
    };
    expect([
      component.metric('total'),
      component.metric('NEW'),
      component.metric('INTERESTED'),
      component.metric('TRIAL_SCHEDULED'),
      component.metric('followUpsToday'),
      component.metric('overdueFollowUps'),
      component.metric('CONVERTED'),
      component.metric('LOST'),
      component.metric('conversionRate')
    ]).toEqual([10, 3, 1, 1, 4, 2, 2, 1, '20%']);
  });

  it('shows converted and lost analytics totals grouped by source', () => {
    component.analyticsData = {
      sources: [
        { _id: 'Referral', total: 4, converted: 2, lost: 1 },
        { _id: 'Website', total: 3, converted: 1, lost: 0 }
      ]
    };

    expect(component.chartRows('convertedBySource')).toEqual([
      { label: 'Referral', value: 2 },
      { label: 'Website', value: 1 }
    ]);
    expect(component.chartRows('lostBySource')).toEqual([
      { label: 'Referral', value: 1 },
      { label: 'Website', value: 0 }
    ]);
  });

  it('creates Indian call and WhatsApp URLs only for valid ten-digit numbers', () => {
    const prospect = { _id: 'e1', fullName: 'Alex', phone: '098765 43210', gender: 'Male' } as any;
    expect(component.phoneUrl(prospect.phone)).toBe('tel:+919876543210');
    expect(component.whatsappUrl(prospect)).toContain('https://wa.me/919876543210?text=');
    expect(component.phoneUrl('12345')).toBe('');
    expect(component.whatsappUrl({ ...prospect, gender: 'Other' })).toContain(encodeURIComponent('Hello Alex,'));
  });
});
