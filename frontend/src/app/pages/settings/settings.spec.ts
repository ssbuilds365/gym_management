import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AuthService } from '../../services/auth';
import { ManagementService } from '../../services/management';
import { BusinessSettings } from './settings';
import { vi } from 'vitest';

describe('BusinessSettings password controls', () => {
  let fixture: ComponentFixture<BusinessSettings>;
  let component: BusinessSettings;
  let changePassword: ReturnType<typeof vi.fn>;
  let uploadBusinessLogo: ReturnType<typeof vi.fn>;
  let removeBusinessLogo: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    changePassword = vi.fn().mockReturnValue(of({
      success: true,
      message: 'Password changed successfully.'
    }));
    uploadBusinessLogo = vi.fn();
    removeBusinessLogo = vi.fn();
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
            getSettings: () => of({ business: { logoUrl: 'https://cdn.example.com/old-logo.webp' } }),
            uploadBusinessLogo,
            removeBusinessLogo
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

  it('rejects an original logo larger than 200 KB before image processing', async () => {
    const file = new File([new Uint8Array(200 * 1024 + 1)], 'large.png', { type: 'image/png' });
    const event = { target: { files: [file], value: 'large.png' } } as unknown as Event;

    await component.onLogoSelected(event);

    expect(component.logoError).toBe('Logo image must be 200 KB or smaller.');
    expect(component.form.logoUrl).toBe('https://cdn.example.com/old-logo.webp');
    expect(uploadBusinessLogo).not.toHaveBeenCalled();
  });

  it('keeps the existing logo until a replacement is confirmed by the backend', () => {
    expect(component.form.logoUrl).toBe('https://cdn.example.com/old-logo.webp');
    expect(component.logoPreview).toBe(component.form.logoUrl);
    expect(component.form.logoUrl).not.toContain('data:image');
  });

  it('updates the displayed profile only after the backend confirms a logo upload', () => {
    const updatedBusiness = {
      businessName: 'Test Gym',
      logoUrl: 'https://res.cloudinary.com/test/business-logo.webp',
      logoStorage: { publicId: 'business-logos/id/logo', format: 'webp', width: 200, height: 100, bytes: 45000 }
    };
    uploadBusinessLogo.mockReturnValue(of({
      success: true,
      business: updatedBusiness,
      compression: { originalBytes: 120000, compressedBytes: 45000, targetRangeMet: true }
    }));
    const selectedFile = new File(['image'], 'logo.png', { type: 'image/png' });
    component.selectedLogoFile = selectedFile;
    let updatedLogo = '';
    component.businessLogoUpdated.subscribe(url => updatedLogo = url);

    component.uploadLogo();

    expect(uploadBusinessLogo).toHaveBeenCalledWith(selectedFile);
    expect(component.form.logoUrl).toBe(updatedBusiness.logoUrl);
    expect(component.logoStorage?.bytes).toBe(45000);
    expect(component.logoOriginalBytes).toBe(120000);
    expect(component.logoCompressedBytes).toBe(45000);
    expect(updatedLogo).toBe(updatedBusiness.logoUrl);
  });

  it('clears the logo after the backend confirms removal', () => {
    removeBusinessLogo.mockReturnValue(of({
      success: true,
      business: { businessName: 'Test Gym', logoUrl: '', logoStorage: null },
      cleanupPending: false
    }));
    let updatedLogo = 'old';
    component.businessLogoUpdated.subscribe(url => updatedLogo = url);

    component.removeLogo();

    expect(removeBusinessLogo).toHaveBeenCalled();
    expect(component.form.logoUrl).toBe('');
    expect(component.logoPreview).toBe('');
    expect(updatedLogo).toBe('');
  });
});
