
import {
  ChangeDetectorRef,
  Component,
  OnInit,
  OnDestroy,
  ElementRef,
  Input,
  OnChanges,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  BrowserMultiFormatReader,
  IScannerControls
} from '@zxing/browser';

import { AttendanceService } from '../../services/attendance';
import { MemberService } from '../../services/member';
import { jsPDF } from 'jspdf';
import { environment } from '../../../environments/environment';
import { Observable, finalize, map } from 'rxjs';

@Component({
  selector: 'app-attendance',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './attendance.html',
  styleUrl: './attendance.scss'
})
export class Attendance implements OnInit, OnDestroy, OnChanges {

  @ViewChild('qrVideo')
  qrVideo!: ElementRef<HTMLVideoElement>;
  @Input() active = false;

  members: any[] = [];
  attendanceList: any[] = [];
  checkedInCount = 0;

  selectedMemberId = '';
  selectedDate = this.getTodayDate();

  loadingMembers = false;
  loadingAttendance = false;
  attendanceLoaded = false;
  private lastLoadedAt = 0;
  processing = false;

  successMessage = '';
  errorMessage = '';
  exportLoading = false;
  exportErrorMessage = '';

  // QR Scanner properties
  qrScannerOpen = false;
  qrScanning = false;
  qrProcessing = false;

  private codeReader = new BrowserMultiFormatReader();
  private scannerControls?: IScannerControls;
  private scanLocked = false;

  constructor(
    private attendanceService: AttendanceService,
    private memberService: MemberService,
    private changeDetector: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadMembers();
    this.loadDailyAttendance();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (
      changes['active'] &&
      !changes['active'].firstChange &&
      this.active &&
      (!this.lastLoadedAt || Date.now() - this.lastLoadedAt >= 60_000)
    ) {
      if (!this.loadingMembers) {
        this.loadMembers();
      }
      if (!this.loadingAttendance) {
        this.loadDailyAttendance();
      }
    }
  }

  ngOnDestroy(): void {
    this.stopQRScanner();
  }

  // Get today's local date
  getTodayDate(): string {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  // Load Members
  loadMembers(): void {
    this.loadingMembers = true;
    this.changeDetector.markForCheck();

    this.memberService.getMembers('', '', 1, 100)
      .pipe(finalize(() => {
        this.loadingMembers = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
      next: (response: any) => {
        this.members = response.members || [];
      },
      error: (error: any) => {
        console.error('Members loading error:', error);
        this.errorMessage = 'Unable to load members.';
      }
    });
  }

  // Load Daily Attendance
  loadDailyAttendance(): void {
    this.loadingAttendance = true;
    this.attendanceLoaded = false;
    this.errorMessage = '';
    this.changeDetector.markForCheck();

    this.attendanceService
      .getDailyAttendance(this.selectedDate)
      .pipe(finalize(() => {
        this.loadingAttendance = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: (response: any) => {
          this.attendanceList = response.attendance || [];
          this.checkedInCount = this.attendanceList.filter(
            attendance => !attendance.checkOut
          ).length;
          this.attendanceLoaded = true;
          this.lastLoadedAt = Date.now();
        },
        error: (error: any) => {
          console.error('Attendance loading error:', error);
          this.errorMessage = 'Unable to load attendance.';
        }
      });
  }

  // Manual Check-in
  markCheckIn(): void {
    if (this.processing) {
      return;
    }

    if (!this.selectedMemberId) {
      this.errorMessage = 'Please select a member.';
      return;
    }

    this.processing = true;
    this.successMessage = '';
    this.errorMessage = '';

    this.attendanceService.checkIn({
      memberId: this.selectedMemberId,
      attendanceType: 'Manual',
      notes: ''
    }).pipe(finalize(() => {
      this.processing = false;
      this.changeDetector.markForCheck();
    })).subscribe({
      next: (response: any) => {
        this.successMessage = response.message || 'Check-in successful.';
        this.selectedMemberId = '';
        this.loadDailyAttendance();
      },
      error: (error: any) => {
        this.errorMessage =
          error.error?.message || 'Check-in failed.';
      }
    });
  }

  // Manual Check-out
  markCheckOut(memberId: string): void {
    if (this.processing) {
      return;
    }

    this.processing = true;
    this.successMessage = '';
    this.errorMessage = '';

    this.attendanceService.checkOut(memberId)
      .pipe(finalize(() => {
        this.processing = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
      next: (response: any) => {
        this.successMessage = response.message || 'Check-out successful.';
        this.loadDailyAttendance();
      },
      error: (error: any) => {
        this.errorMessage =
          error.error?.message || 'Check-out failed.';
      }
    });
  }

  // Open QR Scanner
  openQRScanner(): void {
    this.successMessage = '';
    this.errorMessage = '';
    this.scanLocked = false;
    this.qrScannerOpen = true;
  }

  // Start camera scanner
  async startQRScanner(): Promise<void> {
    try {
      if (!this.qrVideo?.nativeElement) {
        this.errorMessage = 'Scanner camera is not ready. Please try again.';
        return;
      }

      this.errorMessage = '';
      this.qrScanning = true;
      this.changeDetector.markForCheck();

      this.scannerControls =
        await this.codeReader.decodeFromVideoDevice(
          undefined,
          this.qrVideo.nativeElement,
          (result) => {
            if (result && !this.scanLocked) {
              this.scanLocked = true;

              const qrToken = result.getText();

              this.stopQRScanner();
              this.submitQRAttendance(qrToken);
              this.changeDetector.markForCheck();
            }
          }
        );

    } catch (error) {
      console.error('QR Scanner Error:', error);
      this.qrScanning = false;
      this.errorMessage =
        'Unable to access camera. Please allow camera permission and try again.';
      this.changeDetector.markForCheck();
    }
  }

  // Send QR token to backend
  submitQRAttendance(qrToken: string): void {
    if (this.qrProcessing) {
      return;
    }

    this.qrProcessing = true;
    this.successMessage = '';
    this.errorMessage = '';
    this.changeDetector.markForCheck();

    this.attendanceService.checkInWithQR(qrToken)
      .pipe(finalize(() => {
        this.qrProcessing = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
      next: (response: any) => {
        this.successMessage =
          `${response.member?.fullName || 'Member'} - ${response.message}`;

        this.qrScannerOpen = false;
        this.scanLocked = false;

        this.loadDailyAttendance();
      },
      error: (error: any) => {
        this.errorMessage =
          error.error?.message || 'QR attendance failed.';

        this.scanLocked = false;
      }
    });
  }

  // Stop camera
  stopQRScanner(): void {
    if (this.scannerControls) {
      this.scannerControls.stop();
      this.scannerControls = undefined;
    }

    this.qrScanning = false;
  }

  // Close scanner
  closeQRScanner(): void {
    this.stopQRScanner();
    this.qrScannerOpen = false;
    this.scanLocked = false;
    this.qrProcessing = false;
  }

  // Change attendance date
  onDateChange(): void {
    this.loadDailyAttendance();
  }

  private getExportRows(): Observable<any[]> {
    return this.attendanceService.getDailyAttendance(this.selectedDate).pipe(
      map((response: any) => response.attendance || [])
    );
  }

  private getExportContext(): { businessName: string; selectedDate: string } {
    let businessName = environment.appName;
    const businessJson = localStorage.getItem('business');
    if (businessJson) {
      try {
        businessName = JSON.parse(businessJson).businessName || businessName;
      } catch (error) {
        console.error('Unable to read business name for attendance export:', error);
      }
    }

    const [year, month, day] = this.selectedDate.split('-').map(Number);
    const selectedDate = new Date(year, month - 1, day).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    });
    return { businessName, selectedDate };
  }

  private getExportRecords(attendance: any[]): string[][] {
    return attendance.map(record => {
      const member = record.memberId;
      const attendanceDate = record.attendanceDate
        ? new Date(record.attendanceDate).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC'
          })
        : new Date(record.checkIn).toLocaleDateString('en-IN');

      return [
        String(member?._id || member || ''),
        String(member?.fullName || 'Unknown Member'),
        String(member?.phone || ''),
        attendanceDate,
        this.formatTime(record.checkIn),
        record.checkOut ? this.formatTime(record.checkOut) : 'Not Checked Out',
        record.attendanceType === 'QR' ? 'QR Code' : String(record.attendanceType || ''),
        String(record.status || '')
      ];
    });
  }

  private formatTime(value: string | Date): string {
    return new Date(value).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character] || character);
  }

  private withExportRows(onRows: (attendance: any[]) => void): void {
    if (this.exportLoading) return;
    this.exportLoading = true;
    this.exportErrorMessage = '';
    this.getExportRows()
      .pipe(finalize(() => {
        this.exportLoading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: onRows,
        error: error => {
          console.error('Attendance export error:', error);
          this.exportErrorMessage =
            error.error?.message || 'Unable to export attendance records.';
        }
      });
  }

  private readonly exportHeaders = [
    'Member ID',
    'Member Name',
    'Phone',
    'Attendance Date',
    'Check-in Time',
    'Check-out Time',
    'Attendance Type',
    'Status'
  ];

  exportPdf(): void {
    this.withExportRows(attendance => {
      const context = this.getExportContext();
      const records = this.getExportRecords(attendance);
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const margin = 10;
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const weights = [0.12, 0.15, 0.11, 0.13, 0.11, 0.15, 0.12, 0.11];
      const widths = weights.map(weight => (pageWidth - margin * 2) * weight);
      let y = 16;

      const drawHeading = (): void => {
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(17);
        pdf.setTextColor(181, 31, 43);
        const businessName = pdf.splitTextToSize(
          context.businessName,
          pageWidth - margin * 2
        );
        pdf.text(businessName, margin, y);
        y += Math.max(8, businessName.length * 7);
        pdf.setFontSize(12);
        pdf.setTextColor(32, 33, 36);
        pdf.text(`Daily Attendance - ${context.selectedDate}`, margin, y);
        y += 7;
      };

      const drawTableHeader = (): void => {
        let x = margin;
        this.exportHeaders.forEach((header, index) => {
          const width = widths[index];
          pdf.setFillColor(37, 38, 48);
          pdf.setDrawColor(216, 216, 216);
          pdf.rect(x, y, width, 10, 'FD');
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(7);
          pdf.setTextColor(255, 255, 255);
          pdf.text(pdf.splitTextToSize(header, width - 3), x + 1.5, y + 4);
          x += width;
        });
        y += 10;
      };

      drawHeading();
      drawTableHeader();
      const rows = records.length
        ? records
        : [['No attendance records for this date.', '', '', '', '', '', '', '']];
      rows.forEach((record, rowIndex) => {
        const wrapped = record.map((value, index) =>
          pdf.splitTextToSize(value || '—', widths[index] - 3)
        );
        const rowHeight = Math.max(7, Math.max(...wrapped.map(lines => lines.length)) * 3.5 + 3);
        if (y + rowHeight > pageHeight - margin) {
          pdf.addPage();
          y = margin;
          drawTableHeader();
        }
        let x = margin;
        record.forEach((_value, index) => {
          pdf.setFillColor(
            rowIndex % 2 === 0 ? 255 : 245,
            rowIndex % 2 === 0 ? 255 : 246,
            rowIndex % 2 === 0 ? 255 : 248
          );
          pdf.setDrawColor(216, 216, 216);
          pdf.rect(x, y, widths[index], rowHeight, 'FD');
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(7);
          pdf.setTextColor(32, 33, 36);
          pdf.text(wrapped[index], x + 1.5, y + 4);
          x += widths[index];
        });
        y += rowHeight;
      });

      pdf.save(`attendance-${this.selectedDate}.pdf`);
    });
  }

  exportCsv(): void {
    this.withExportRows(attendance => {
      const context = this.getExportContext();
      const rows = [
        [context.businessName],
        [`Daily Attendance - ${context.selectedDate}`],
        [],
        this.exportHeaders,
        ...this.getExportRecords(attendance)
      ];
      const content = `\uFEFF${rows.map(row =>
        row.map(value => {
          const text = String(value);
          const safeText = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
          return `"${safeText.replace(/"/g, '""')}"`;
        }).join(',')
      ).join('\r\n')}`;
      this.downloadBlob(
        new Blob([content], { type: 'text/csv;charset=utf-8' }),
        `attendance-${this.selectedDate}.csv`
      );
    });
  }

  exportExcel(): void {
    this.withExportRows(attendance => {
      const context = this.getExportContext();
      const xmlEscape = (value: string) => this.escapeHtml(value)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
      const row = (cells: string[], style?: string) =>
        `<Row>${cells.map(value =>
          `<Cell${style ? ` ss:StyleID="${style}"` : ''}><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`
        ).join('')}</Row>`;
      const records = this.getExportRecords(attendance);
      const content = `<?xml version="1.0"?>
        <?mso-application progid="Excel.Sheet"?>
        <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
         xmlns:o="urn:schemas-microsoft-com:office:office"
         xmlns:x="urn:schemas-microsoft-com:office:excel"
         xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
         <Styles>
          <Style ss:ID="Title"><Font ss:Bold="1" ss:Size="16" ss:Color="#B51F2B"/></Style>
          <Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#252630" ss:Pattern="Solid"/></Style>
         </Styles>
         <Worksheet ss:Name="Attendance"><Table>
          ${row([context.businessName], 'Title')}
          ${row([`Daily Attendance - ${context.selectedDate}`])}
          <Row/>
          ${row(this.exportHeaders, 'Header')}
          ${records.map(record => row(record)).join('')}
         </Table></Worksheet></Workbook>`;
      this.downloadBlob(
        new Blob([content], { type: 'application/vnd.ms-excel;charset=utf-8' }),
        `attendance-${this.selectedDate}.xls`
      );
    });
  }

  printReport(): void {
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
      this.exportErrorMessage = 'The report window was blocked. Allow pop-ups and try again.';
      return;
    }

    this.withExportRows(attendance => {
      const context = this.getExportContext();
      const records = this.getExportRecords(attendance);
      const tableRows = records.map(record =>
        `<tr>${record.map(value => `<td>${this.escapeHtml(value)}</td>`).join('')}</tr>`
      ).join('');
      reportWindow.document.open();
      reportWindow.document.write(`<!doctype html>
        <html><head><meta charset="utf-8">
        <title>Daily Attendance - ${this.escapeHtml(context.selectedDate)}</title>
        <style>
          @page { size: landscape; margin: 14mm; }
          body { font-family: Arial, sans-serif; color: #252525; padding: 18px; }
          h1 { margin: 0 0 6px; color: #b51f2b; font-size: 22px; }
          h2 { margin: 0 0 18px; font-size: 16px; }
          table { width: 100%; border-collapse: collapse; }
          th { background: #252630; color: #fff; text-align: left; }
          th, td { padding: 8px; border: 1px solid #d8d8d8; font-size: 10px; }
          tbody tr:nth-child(even) { background: #f5f6f8; }
        </style></head><body>
        <h1>${this.escapeHtml(context.businessName)}</h1>
        <h2>Daily Attendance - ${this.escapeHtml(context.selectedDate)}</h2>
        <table><thead><tr>${this.exportHeaders.map(header => `<th>${header}</th>`).join('')}</tr></thead>
        <tbody>${tableRows || `<tr><td colspan="${this.exportHeaders.length}">No attendance records for this date.</td></tr>`}</tbody>
        </table></body></html>`);
      reportWindow.document.close();
      reportWindow.focus();
      reportWindow.print();
    });
  }

  private downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

}
