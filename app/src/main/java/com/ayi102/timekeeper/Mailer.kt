package com.ayi102.timekeeper

import java.util.Properties
import javax.activation.DataHandler
import javax.mail.Authenticator
import javax.mail.Message
import javax.mail.PasswordAuthentication
import javax.mail.Session
import javax.mail.Transport
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeBodyPart
import javax.mail.internet.MimeMessage
import javax.mail.internet.MimeMultipart
import javax.mail.util.ByteArrayDataSource

/** Sends mail over SMTP+STARTTLS (Gmail) with a single attachment. Call off the UI thread. */
object Mailer {
    fun send(
        s: Settings,
        subject: String,
        bodyText: String,
        attachmentName: String,
        attachmentBytes: ByteArray,
    ) {
        val props = Properties().apply {
            put("mail.smtp.auth", "true")
            put("mail.smtp.starttls.enable", "true")
            put("mail.smtp.host", s.host())
            put("mail.smtp.port", s.port().toString())
        }
        val session = Session.getInstance(props, object : Authenticator() {
            override fun getPasswordAuthentication() = PasswordAuthentication(s.user(), s.password())
        })

        val text = MimeBodyPart().apply { setText(bodyText) }
        val file = MimeBodyPart().apply {
            dataHandler = DataHandler(ByteArrayDataSource(attachmentBytes, "application/gzip"))
            fileName = attachmentName
        }
        val msg = MimeMessage(session).apply {
            setFrom(InternetAddress(s.user()))
            setRecipients(Message.RecipientType.TO, InternetAddress.parse(s.to()))
            this.subject = subject
            setContent(MimeMultipart().apply { addBodyPart(text); addBodyPart(file) })
        }
        Transport.send(msg)
    }
}
