import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MembershipPlans } from './membership-plans';

describe('MembershipPlans', () => {
  let component: MembershipPlans;
  let fixture: ComponentFixture<MembershipPlans>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MembershipPlans],
    }).compileComponents();

    fixture = TestBed.createComponent(MembershipPlans);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
