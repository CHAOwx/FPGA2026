// 7段数码管
`timescale 1ns / 1ps
module Seg8 #(
    parameter integer CLK_FREQ_HZ = 50000000,
    parameter integer SCAN_FREQ_HZ = 1000,
    parameter integer DECIMAL_SPLIT = 0 // 1：十进制左右四位分别去除前导零
)(
    input wire clk,
    input wire reset_n,
    // Unsigned value; 00: binary low 8 bits, 01: decimal low 8 digits,
    // 10: hexadecimal, 11: blank. Leading zeros are suppressed.
    input wire [31:0] data,
    input wire [1:0] format,
    output reg ds,
    output reg sh_cp,
    output reg st_cp
    
    );
    localparam integer SLOT_CYCLES = CLK_FREQ_HZ / SCAN_FREQ_HZ;
    localparam integer SLOT_WIDTH = (SLOT_CYCLES > 1) ? $clog2(SLOT_CYCLES) : 1;

    // Inputs must be synchronous to clk. Conversion snapshots both inputs.
    reg converting;
    reg [1:0] sampled_format;
    reg [31:0] sampled_data;
    reg [31:0] binary_shift;
    reg [39:0] bcd;
    reg [5:0] conversion_step;
    reg [39:0] bcd_adjusted;
    wire [39:0] bcd_next = {bcd_adjusted[38:0], binary_shift[31]};
    reg [31:0] converted_digits;
    reg [31:0] pending_digits;
    reg [7:0] pending_mask;
    integer j;
    integer k;

    function [7:0] visible_mask;
        input [31:0] digits;
        integer i;
        reg found;
        begin
            visible_mask = 8'b00000001;
            found = 1'b0;
            for (i = 7; i >= 0; i = i - 1) begin
                if (digits[i*4 +: 4] != 0)
                    found = 1'b1;
                if (found)
                    visible_mask[i] = 1'b1;
            end
        end
    endfunction

    function [6:0] segment_code;
        input [3:0] digit;
        begin
            case (digit)
                4'h0: segment_code = 7'b1000000;
                4'h1: segment_code = 7'b1111001;
                4'h2: segment_code = 7'b0100100;
                4'h3: segment_code = 7'b0110000;
                4'h4: segment_code = 7'b0011001;
                4'h5: segment_code = 7'b0010010;
                4'h6: segment_code = 7'b0000010;
                4'h7: segment_code = 7'b1111000;
                4'h8: segment_code = 7'b0000000;
                4'h9: segment_code = 7'b0010000;
                4'ha: segment_code = 7'b0001000;
                4'hb: segment_code = 7'b0000011;
                4'hc: segment_code = 7'b1000110;
                4'hd: segment_code = 7'b0100001;
                4'he: segment_code = 7'b0000110;
                4'hf: segment_code = 7'b0001110;
                default: segment_code = 7'b1111111;
            endcase
        end
    endfunction

    always @(*) begin
        bcd_adjusted = bcd;
        for (j = 0; j < 10; j = j + 1)
            if (bcd[j*4 +: 4] >= 5)
                bcd_adjusted[j*4 +: 4] = bcd[j*4 +: 4] + 4'd3;
        converted_digits = 32'b0;
        case (sampled_format)
            2'b00: begin
                for (k = 0; k < 8; k = k + 1)
                    converted_digits[k*4 +: 4] = {3'b0, sampled_data[k]};
            end
            2'b01: converted_digits = bcd_next[31:0];
            2'b10: converted_digits = sampled_data;
            default: converted_digits = 32'b0;
        endcase
    end

    always @(posedge clk or negedge reset_n) begin
        if (!reset_n) begin
            converting <= 1'b0;
            sampled_format <= 2'b11;
            sampled_data <= 0;
            binary_shift <= 0;
            bcd <= 0;
            conversion_step <= 0;
            pending_digits <= 0;
            pending_mask <= 0;
        end else if (!converting) begin
            sampled_data <= data;
            sampled_format <= format;
            binary_shift <= data;
            bcd <= 0;
            conversion_step <= 0;
            converting <= 1'b1;
        end else if ((sampled_format != 2'b01) || (conversion_step == 31)) begin
            pending_digits <= converted_digits;
            if (sampled_format == 2'b11)
                pending_mask <= 8'b0;
            else if ((sampled_format == 2'b01) && DECIMAL_SPLIT)
                pending_mask <= (visible_mask({16'b0, converted_digits[31:16]}) << 4) |
                                (visible_mask({16'b0, converted_digits[15:0]}) & 8'h0f);
            else
                pending_mask <= visible_mask(converted_digits);
            converting <= 1'b0;
        end else begin
            bcd <= bcd_next;
            binary_shift <= {binary_shift[30:0], 1'b0};
            conversion_step <= conversion_step + 1'b1;
        end
    end

    reg [31:0] active_digits;
    reg [7:0] active_mask;
    reg [2:0] digit_index;
    reg [1:0] scan_state;
    reg [SLOT_WIDTH-1:0] slot_counter;
    reg tx_start;
    reg [15:0] tx_payload;
    reg tx_done;
    wire [31:0] frame_digits = (digit_index == 0) ? pending_digits : active_digits;
    wire [7:0] frame_mask = (digit_index == 0) ? pending_mask : active_mask;
    wire [3:0] scan_digit = frame_digits[digit_index*4 +: 4];

    // Blank the old digit before loading the new segment pattern.
    always @(posedge clk or negedge reset_n) begin
        if (!reset_n) begin
            active_digits <= 0;
            active_mask <= 0;
            digit_index <= 0;
            scan_state <= 0;
            slot_counter <= 0;
            tx_start <= 0;
            tx_payload <= 16'hff00;
        end else begin
            tx_start <= 0;
            if (slot_counter < SLOT_CYCLES - 1)
                slot_counter <= slot_counter + 1'b1;
            case (scan_state)
                0: begin
                    tx_payload <= 16'hff00;
                    tx_start <= 1;
                    slot_counter <= 0;
                    scan_state <= 1;
                end
                1: if (tx_done) begin
                    if (digit_index == 0) begin
                        active_digits <= pending_digits;
                        active_mask <= pending_mask;
                    end
                    tx_payload <= frame_mask[digit_index] ?
                        {1'b1, segment_code(scan_digit), (8'b1 << digit_index)} : 16'hff00;
                    tx_start <= 1;
                    scan_state <= 2;
                end
                2: if (tx_done)
                    scan_state <= 3;
                3: if (slot_counter == SLOT_CYCLES - 2) begin
                    digit_index <= digit_index + 1'b1;
                    scan_state <= 0;
                end
            endcase
        end
    end

    reg [2:0] tx_state;
    reg [15:0] tx_shift;
    reg [3:0] tx_bit;
    reg half_cycle;
    // Two clk cycles per half period: 12.5 MHz SH_CP at 50 MHz clk.
    always @(posedge clk or negedge reset_n) begin
        if (!reset_n) begin
            ds <= 0;
            sh_cp <= 0;
            st_cp <= 0;
            tx_state <= 0;
            tx_shift <= 0;
            tx_bit <= 0;
            half_cycle <= 0;
            tx_done <= 0;
        end else begin
            tx_done <= 0;
            if (tx_state == 0) begin
                if (tx_start) begin
                    tx_shift <= tx_payload;
                    ds <= tx_payload[15];
                    tx_bit <= 0;
                    half_cycle <= 0;
                    tx_state <= 1;
                end
            end else if (!half_cycle)
                half_cycle <= 1;
            else begin
                half_cycle <= 0;
                case (tx_state)
                    1: begin
                        sh_cp <= 1;
                        tx_state <= 2;
                    end
                    2: begin
                        sh_cp <= 0;
                        if (tx_bit == 15)
                            tx_state <= 3;
                        else begin
                            tx_shift <= {tx_shift[14:0], 1'b0};
                            ds <= tx_shift[14];
                            tx_bit <= tx_bit + 1'b1;
                            tx_state <= 1;
                        end
                    end
                    3: begin
                        st_cp <= 1;
                        tx_state <= 4;
                    end
                    4: begin
                        st_cp <= 0;
                        tx_done <= 1;
                        tx_state <= 0;
                    end
                    default: tx_state <= 0;
                endcase
            end
        end
    end

    // synthesis translate_off
    initial begin
        if ((CLK_FREQ_HZ <= 0) || (SCAN_FREQ_HZ <= 0) || (SLOT_CYCLES < 160))
            $fatal(1, "Seg8 requires positive frequencies and at least 160 clocks per digit");
    end
    // synthesis translate_on
endmodule
