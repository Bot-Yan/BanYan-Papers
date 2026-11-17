import io
import unittest

import pikepdf

from unlock_server import app


def pdf_bytes(encryption=None):
    stream = io.BytesIO()
    with pikepdf.Pdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(stream, encryption=encryption)
    return stream.getvalue()


class UnlockTest(unittest.TestCase):
    def test_plain_pdf_is_returned_unchanged(self):
        original = pdf_bytes()
        response = app.test_client().post("/api/pdf/unlock", data=original)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["X-Unlock-Encrypted"], "0")
        self.assertEqual(response.data, original)

    def test_empty_open_password_returns_an_unencrypted_pdf(self):
        original = pdf_bytes(pikepdf.Encryption(owner="fixture-owner", user=""))
        response = app.test_client().post("/api/pdf/unlock", data=original)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["X-Unlock-Encrypted"], "1")
        with pikepdf.Pdf.open(io.BytesIO(response.data)) as pdf:
            self.assertFalse(pdf.is_encrypted)
            self.assertEqual(len(pdf.pages), 1)

    def test_required_open_password_returns_422(self):
        original = pdf_bytes(pikepdf.Encryption(owner="fixture-owner", user="fixture-user"))
        response = app.test_client().post("/api/pdf/unlock", data=original)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json["reason"], "needs-password")
