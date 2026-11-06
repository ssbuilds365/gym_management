import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AuthService } from '../../services/auth';
import { ManagementService } from '../../services/management';
import { BusinessSettings } from './settings';

describe('BusinessSettings password controls', () => {
  let fixture: ComponentFixture<BusinessSettings>;
  let component: BusinessSettings;
  let changePassword: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    changePassword = vi.fn().mockReturnValue(of({
      success: true,
      message: 'Password changed successfully.'
    }));
    await TestBed.configureTestingModule({
      imports: [BusinessSettings],
      providers: [
        {
          provide: AuthService,
          useValue: {
            getSessions: () => of({ sessions: [] }),
            changePassword
          }
        },
        {
          provide: ManagementService,
          useValue: {
            getSettings: () => of({ business: {} })
          }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(BusinessSettings);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('rejects invalid confirmation before calling the API', () => {
    component.passwordForm = {
      currentPassword: 'CurrentPassword1!',
      newPassword: 'NewPassword2!',
      confirmPassword: 'NotTheSame2!'
    };

    component.changePassword();

    expect(component.passwordError).toContain('do not match');
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('submits the passwords, clears them, and signals forced reauthentication', () => {
    let passwordChanged = false;
    component.passwordChanged.subscribe(() => passwordChanged = true);
    component.passwordForm = {
      currentPassword: 'CurrentPassword1!',
      newPassword: 'NewPassword2!',
      confirmPassword: 'NewPassword2!'
    };

    component.changePassword();

    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: 'CurrentPassword1!',
      newPassword: 'NewPassword2!',
      confirmPassword: 'NewPassword2!'
    });
    expect(component.passwordForm).toEqual({
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
    });
    expect(passwordChanged).toBe(true);
  });
});
